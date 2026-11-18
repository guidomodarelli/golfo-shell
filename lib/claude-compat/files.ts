import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { MAX_SCAN_DEPTH } from "./constants.ts";

/** Hash of every derived file, recorded so later syncs never overwrite user edits. */
export type ManagedFiles = Record<string, string>;

/** Owner read/write only: derived files stay private to group and others. */
export const PRIVATE_FILE_MODE = 0o600;
/** Owner read/write/execute only, for derived copies of executable resources. */
export const PRIVATE_EXECUTABLE_FILE_MODE = 0o700;
/** POSIX permission bit that marks a file executable by its owner. */
export const OWNER_EXECUTE_BIT = 0o100;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PERMISSION_BITS_MASK = 0o777;

/** Reads an optional JSON file. Absence returns the fallback; corrupt JSON is an error, never ignored. */
export function readJsonFile<T>(path: string, fallback: T): T {
	if (!existsSync(path)) return fallback;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch (error) {
		throw new Error(`claude-compat:readJsonFile failed: invalid JSON in ${path}`, { cause: error });
	}
}

export function digest(content: string | Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

/** Whether `path` is inside `root` (both already resolved). */
export function isInside(root: string, path: string): boolean {
	const portion = relative(root, path);
	return portion.length > 0 && !portion.startsWith("..") && !isAbsolute(portion);
}

export interface Frontmatter {
	fields: Record<string, string>;
	body: string;
	/** Whether the text starts with a frontmatter block. */
	present: boolean;
	/** Non-empty, non-comment frontmatter lines that could not be assigned to any key. */
	unparsed: string[];
}

const YAML_COMMENT_MARKER = "#";
const YAML_QUOTES = new Set(["'", "\""]);
const BLOCK_SCALAR_PATTERN = /^[>|][+-]?$/;

/**
 * Removes a trailing YAML comment from one frontmatter value: a `#` at the
 * start or after whitespace, outside a quoted span. Quotes only open a span at
 * the start of a token, so apostrophes (`it's`) and `#` inside words (`C#`,
 * `url#anchor`) stay literal.
 */
export function stripYamlComment(value: string): string {
	let quote: string | undefined;
	for (let index = 0; index < value.length; index++) {
		const character = value[index];
		const previous = index > 0 ? value[index - 1] : " ";
		if (quote) {
			if (quote === "\"" && character === "\\") { index++; continue; }
			if (character === quote) {
				if (quote === "'" && value[index + 1] === "'") { index++; continue; }
				quote = undefined;
			}
			continue;
		}
		if (YAML_QUOTES.has(character) && /[\s[(,:]/.test(previous)) { quote = character; continue; }
		if (character === YAML_COMMENT_MARKER && /\s/.test(previous)) return value.slice(0, index).trimEnd();
	}
	return value;
}

/** Simple scalar frontmatter reader: keeps the body untouched, drops YAML comments and folds `>`/`|` blocks to one line. */
export function readFrontmatter(text: string): Frontmatter {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
	if (!match) return { fields: {}, body: text, present: false, unparsed: [] };
	const fields: Record<string, string> = {};
	const unparsed: string[] = [];
	let currentKey: string | undefined;
	let inBlockScalar = false;
	for (const line of match[1].split(/\r?\n/)) {
		const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
		if (pair) {
			currentKey = pair[1];
			const value = stripYamlComment(pair[2]).trim();
			inBlockScalar = BLOCK_SCALAR_PATTERN.test(value);
			fields[currentKey] = value.replace(/^(['"])([\s\S]*)\1$/, "$2");
		} else if (currentKey && !inBlockScalar && /^-(?:\s|$)/.test(line)) {
			// YAML allows block sequence items at the same indentation as their key.
			const item = stripYamlComment(line.trim());
			if (item) fields[currentKey] += `\n${item}`;
		} else if (currentKey && /^\s+\S/.test(line)) {
			// Inside `>`/`|` blocks a `#` is content; elsewhere comment lines are skipped.
			const continuation = inBlockScalar ? line.trim() : stripYamlComment(line.trim());
			if (continuation) fields[currentKey] += `\n${continuation}`;
		} else if (stripYamlComment(line.trim())) {
			unparsed.push(line.trim());
		}
	}
	for (const [key, value] of Object.entries(fields)) {
		if (/^[>|][+-]?(?:\n|$)/.test(value)) fields[key] = value.replace(/^[>|][+-]?/, "").trim().replace(/\s+/g, " ");
		else if (value.startsWith("- ") || value.includes("\n- ")) fields[key] = value.split("\n").map((item) => item.replace(/^-\s*/, "").trim()).filter(Boolean).join(", ");
	}
	return { fields, body: match[2], present: true, unparsed };
}

/**
 * Bounded, deterministic walk for Markdown files. Dot directories and
 * `node_modules` are skipped and symlink cycles are visited once.
 */
export function findMarkdownFiles(root: string, fileName?: string, seen: Set<string> = new Set(), depth = 0): string[] {
	if (depth > MAX_SCAN_DEPTH || !existsSync(root)) return [];
	const canonical = realpathSync(root);
	if (seen.has(canonical)) return [];
	seen.add(canonical);
	if (statSync(canonical).isFile()) {
		return root.endsWith(".md") && (!fileName || basename(root) === fileName) ? [root] : [];
	}
	return readdirSync(root).sort().flatMap((name) => {
		if (name.startsWith(".") || name === "node_modules") return [];
		return findMarkdownFiles(join(root, name), fileName, seen, depth + 1);
	});
}

/**
 * Writes a derived file. A file the adapter did not write, or that changed
 * since its last write, is never overwritten. The file always ends with
 * `mode` (default private `0o600`), even when its content was already current.
 */
export function writeManagedFile(path: string, content: string | Buffer, previous: ManagedFiles, written: ManagedFiles, mode: number = PRIVATE_FILE_MODE): void {
	const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
	if (existsSync(path)) {
		const existing = readFileSync(path);
		if (!existing.equals(bytes)) {
			const recorded = previous[path];
			if (!recorded || digest(existing) !== recorded) {
				throw new Error(`claude-compat:writeManagedFile refused: ${path} was modified outside the importer; move or delete it to regenerate`);
			}
			mkdirSync(dirname(path), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
			writeFileSync(path, bytes, { mode });
		}
	} else {
		mkdirSync(dirname(path), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
		writeFileSync(path, bytes, { mode });
	}
	if ((statSync(path).mode & PERMISSION_BITS_MASK) !== mode) chmodSync(path, mode);
	written[path] = digest(bytes);
}

/** Writes a private file only when its content changed. */
export function writePrivateFile(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
	if (existsSync(path) && readFileSync(path, "utf8") === content) return;
	writeFileSync(path, content, { mode: PRIVATE_FILE_MODE });
}

/**
 * Removes derived files that the new sync no longer produces. Files outside the
 * owned roots, symlinks and files edited by the user are kept and returned.
 */
export function pruneManagedFiles(previous: ManagedFiles, next: ManagedFiles, ownedRoots: readonly string[]): string[] {
	const retained: string[] = [];
	for (const [path, hash] of Object.entries(previous)) {
		if (next[path] || !existsSync(path)) continue;
		const owned = ownedRoots.some((root) => isInside(root, path));
		if (!owned || lstatSync(path).isSymbolicLink() || digest(readFileSync(path)) !== hash) {
			retained.push(path);
			continue;
		}
		unlinkSync(path);
	}
	return retained.sort();
}

/** Resolves a file declared by a plugin manifest, refusing anything outside the plugin root. */
export function pluginFile(pluginRoot: string, relativePath: string): string {
	const root = realpathSync(pluginRoot);
	const file = realpathSync(join(root, relativePath));
	if (!isInside(root, file)) throw new Error(`claude-compat:pluginFile refused: ${relativePath} resolves outside its plugin root`);
	return file;
}
