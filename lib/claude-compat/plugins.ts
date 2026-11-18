import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { SKILL_OVERRIDE_DISABLED } from "./constants.ts";
import { readJsonFile } from "./files.ts";

/** One installed Claude Code plugin entry the importer may read. */
export interface ClaudePlugin {
	/** `name@marketplace` key from `installed_plugins.json`. */
	key: string;
	name: string;
	version: string;
	root: string;
	manifest: PluginManifest;
}

export interface PluginManifest {
	skills?: string | string[];
	agents?: string | string[];
	hooks?: string | Record<string, unknown>;
}

/** Why an installed plugin was not imported. */
export interface SkippedPlugin {
	key: string;
	reason: string;
}

interface InstalledEntry {
	scope?: string;
	installPath?: string;
	version?: string;
}

const USER_SCOPE = "user";

/** `~/.claude` directory of the given home. */
export function claudeDirectory(home: string): string {
	return join(home, ".claude");
}

export function readClaudeSettings(home: string): Record<string, unknown> {
	return readJsonFile<Record<string, unknown>>(join(claudeDirectory(home), "settings.json"), {});
}

/**
 * Skill names `skillOverrides` sets to exactly `"off"`. Other values, a missing
 * field or a malformed one disable nothing. Read only: settings are never written.
 */
export function readDisabledSkillNames(home: string): Set<string> {
	const overrides = readClaudeSettings(home).skillOverrides;
	if (typeof overrides !== "object" || overrides === null || Array.isArray(overrides)) return new Set();
	return new Set(Object.entries(overrides).filter(([, value]) => value === SKILL_OVERRIDE_DISABLED).map(([name]) => name));
}

function compareVersionsDescending(left: string, right: string): number {
	return right.localeCompare(left, undefined, { numeric: true });
}

/**
 * Enabled, user-scoped Claude Code plugins, newest version first within each
 * plugin and plugins sorted by name. Project or local scopes of other projects
 * are never promoted to the global import.
 */
export function discoverPlugins(home: string, nativeEquivalents: Readonly<Record<string, string>>): { plugins: ClaudePlugin[]; skipped: SkippedPlugin[] } {
	const settings = readClaudeSettings(home);
	const enabled = (settings.enabledPlugins ?? {}) as Record<string, unknown>;
	const installed = readJsonFile<{ plugins?: Record<string, InstalledEntry[]> }>(join(claudeDirectory(home), "plugins", "installed_plugins.json"), {}).plugins ?? {};
	const plugins: ClaudePlugin[] = [];
	const skipped: SkippedPlugin[] = [];
	for (const key of Object.keys(installed).sort()) {
		const name = key.split("@")[0];
		if (enabled[key] !== true) { skipped.push({ key, reason: "deshabilitado en Claude Code" }); continue; }
		if (nativeEquivalents[name]) { skipped.push({ key, reason: `equivalente nativo: ${nativeEquivalents[name]}` }); continue; }
		const entries = Array.isArray(installed[key]) ? installed[key] : [];
		const userEntries = entries.filter((entry) => entry.scope === USER_SCOPE && typeof entry.installPath === "string" && existsSync(entry.installPath));
		if (userEntries.length === 0) {
			skipped.push({ key, reason: entries.length > 0 ? "solo instalado con scope de proyecto/local" : "sin instalación disponible" });
			continue;
		}
		const unique = new Map<string, ClaudePlugin>();
		for (const entry of userEntries) {
			const root = realpathSync(entry.installPath as string);
			if (unique.has(root)) continue;
			unique.set(root, { key, name, version: String(entry.version ?? ""), root, manifest: readJsonFile<PluginManifest>(join(root, ".claude-plugin", "plugin.json"), {}) });
		}
		plugins.push(...[...unique.values()].sort((left, right) => compareVersionsDescending(left.version, right.version) || left.root.localeCompare(right.root)));
	}
	return { plugins, skipped };
}

/** Manifest field as a list of relative paths. */
export function manifestPaths(value: unknown): string[] {
	if (typeof value === "string") return [value];
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
