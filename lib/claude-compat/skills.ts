import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { CLAUDE_COMPAT_IMPORT_DIRECTORY, CLAUDE_COMPAT_SKILLS_DIRECTORY, CLAUDE_COMPAT_STATE_SCHEMA, SKILL_FILE_NAME, SKILL_NAME_MAX_LENGTH, SKILL_NAME_PATTERN, SKILL_RESOURCE_DIRECTORIES } from "./constants.ts";
import { findMarkdownFiles, isInside, type ManagedFiles, OWNER_EXECUTE_BIT, PRIVATE_EXECUTABLE_FILE_MODE, PRIVATE_FILE_MODE, readFrontmatter, writeManagedFile } from "./files.ts";
import { claudeDirectory, type ClaudePlugin, manifestPaths } from "./plugins.ts";

/** Origin label of skills read from `~/.claude/skills`. */
export const USER_SKILL_OWNER = "user";

export interface SelectedSkill {
	/** Portable name Pi loads. */
	name: string;
	/** Name declared by the original skill. */
	sourceName: string;
	/** File handed to Pi: the original, or its adapted copy in the derived cache. */
	file: string;
	original: string;
	/** Plugin key or `user`. */
	owner: string;
	adapted: boolean;
}

export interface SkillDuplicate {
	name: string;
	selected: string;
	excluded: string;
}

export interface SkippedSkill {
	file: string;
	reason: string;
}

export interface SkillCatalog {
	skills: SelectedSkill[];
	duplicates: SkillDuplicate[];
	skipped: SkippedSkill[];
}

interface SkillCandidate {
	file: string;
	owner: string;
	root: string;
}

/**
 * Portable Agent Skills name: lowercase, `:`/spaces/invalid runs collapsed to a
 * single hyphen. Returns undefined when nothing portable remains.
 */
export function normalizeSkillName(name: string): string | undefined {
	const normalized = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	return normalized.length > 0 && normalized.length <= SKILL_NAME_MAX_LENGTH && SKILL_NAME_PATTERN.test(normalized) ? normalized : undefined;
}

function depthWithin(root: string, file: string): number {
	return relative(root, file).split(/[\\/]/).length;
}

/** Skill files of one plugin, shallowest first so a plugin's top-level skill beats a nested copy. */
function pluginSkillFiles(plugin: ClaudePlugin): string[] {
	const roots = [join(plugin.root, "skills"), ...manifestPaths(plugin.manifest.skills).map((path) => resolve(plugin.root, path))]
		.filter((path) => path === join(plugin.root, "skills") || isInside(plugin.root, path));
	const files = [...new Set(roots)].flatMap((root) => findMarkdownFiles(root, SKILL_FILE_NAME));
	return [...new Set(files)].sort((left, right) => depthWithin(plugin.root, left) - depthWithin(plugin.root, right) || left.localeCompare(right));
}

/**
 * Candidate order is the precedence order: enabled plugins (sorted by key,
 * newest install first) win over legacy `~/.claude/skills`, independently of
 * directory listing order.
 */
export function skillCandidates(home: string, plugins: readonly ClaudePlugin[]): SkillCandidate[] {
	const candidates: SkillCandidate[] = [];
	for (const plugin of plugins) candidates.push(...pluginSkillFiles(plugin).map((file) => ({ file, owner: plugin.key, root: plugin.root })));
	const userRoot = join(claudeDirectory(home), "skills");
	candidates.push(...findMarkdownFiles(userRoot, SKILL_FILE_NAME).map((file) => ({ file, owner: USER_SKILL_OWNER, root: userRoot })));
	return candidates;
}

function copyResources(source: string, target: string, previous: ManagedFiles, written: ManagedFiles, seen: Set<string> = new Set()): void {
	if (!existsSync(source)) return;
	const canonical = realpathSync(source);
	if (seen.has(canonical)) return;
	seen.add(canonical);
	const sourceStats = statSync(canonical);
	if (sourceStats.isFile()) {
		const mode = sourceStats.mode & OWNER_EXECUTE_BIT ? PRIVATE_EXECUTABLE_FILE_MODE : PRIVATE_FILE_MODE;
		writeManagedFile(target, readFileSync(canonical), previous, written, mode);
		return;
	}
	for (const name of readdirSync(canonical).sort()) {
		if (name.startsWith(".") || name === "node_modules") continue;
		copyResources(join(canonical, name), join(target, name), previous, written, seen);
	}
}

function adaptedSkillContent(content: string, name: string, originalDirectory: string): string {
	const renamed = /^(---\r?\n[\s\S]*?^name:[ \t]*).*$/m.test(content)
		? content.replace(/^(---\r?\n[\s\S]*?^name:[ \t]*).*$/m, `$1${name}`)
		: content.replace(/^---\r?\n/, `---\nname: ${name}\n`);
	return `${renamed.trimEnd()}\n\n<!-- ${CLAUDE_COMPAT_STATE_SCHEMA} -->\nCopia adaptada por claude-compat. Directorio original de recursos: ${originalDirectory.split(sep).join("/")}. Resolver allí cualquier referencia relativa que no esté junto a esta copia; el original permanece intacto.\n`;
}

/**
 * Selects one skill per portable name before Pi loads anything. Names Pi
 * already discovers natively keep priority and are never shadowed.
 */
export function buildSkillCatalog(options: {
	home: string;
	agentHome: string;
	plugins: readonly ClaudePlugin[];
	nativeSkillNames: ReadonlySet<string>;
	previous: ManagedFiles;
	written: ManagedFiles;
}): SkillCatalog {
	const selected = new Map<string, SelectedSkill>();
	const duplicates: SkillDuplicate[] = [];
	const skipped: SkippedSkill[] = [];
	const cacheRoot = join(options.agentHome, CLAUDE_COMPAT_IMPORT_DIRECTORY, CLAUDE_COMPAT_SKILLS_DIRECTORY);
	for (const candidate of skillCandidates(options.home, options.plugins)) {
		const content = readFileSync(candidate.file, "utf8");
		const { fields, present } = readFrontmatter(content);
		if (!present || !fields.description?.trim()) { skipped.push({ file: candidate.file, reason: "sin frontmatter con description" }); continue; }
		const sourceName = fields.name?.trim() || basename(dirname(candidate.file));
		const name = normalizeSkillName(sourceName);
		if (!name) { skipped.push({ file: candidate.file, reason: `nombre sin adaptación portable: ${sourceName}` }); continue; }
		if (options.nativeSkillNames.has(name)) { duplicates.push({ name, selected: "pi-native", excluded: candidate.file }); continue; }
		const winner = selected.get(name);
		if (winner) {
			if (realpathSync(winner.original) !== realpathSync(candidate.file)) duplicates.push({ name, selected: winner.original, excluded: candidate.file });
			continue;
		}
		const original = realpathSync(candidate.file);
		const needsAdaptation = sourceName !== name || basename(dirname(original)) !== name;
		let file = original;
		if (needsAdaptation) {
			const target = join(cacheRoot, name, SKILL_FILE_NAME);
			try {
				writeManagedFile(target, adaptedSkillContent(content, name, dirname(original)), options.previous, options.written);
				for (const directory of SKILL_RESOURCE_DIRECTORIES) copyResources(join(dirname(original), directory), join(dirname(target), directory), options.previous, options.written);
			} catch (error) {
				skipped.push({ file: candidate.file, reason: error instanceof Error ? error.message : String(error) });
				continue;
			}
			file = target;
		}
		selected.set(name, { name, sourceName, file, original, owner: candidate.owner, adapted: needsAdaptation });
	}
	return { skills: [...selected.values()], duplicates, skipped };
}

/** Skill names Pi discovers by itself, read from the directories its package manager scans. */
export function nativeSkillNamesFromDirectories(directories: readonly string[]): Set<string> {
	const names = new Set<string>();
	for (const directory of directories) {
		for (const file of findMarkdownFiles(directory, SKILL_FILE_NAME)) {
			const { fields } = readFrontmatter(readFileSync(file, "utf8"));
			const name = normalizeSkillName(fields.name?.trim() || basename(dirname(file)));
			if (name) names.add(name);
		}
	}
	return names;
}
