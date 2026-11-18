import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AgentImportError, buildAgentCatalog, type ConvertedAgent } from "./agents.ts";
import type { AgentPolicy } from "./agent-policy.ts";
import { loadClaudeCompatConfig } from "./config.ts";
import { CLAUDE_COMPAT_IMPORT_DIRECTORY, CLAUDE_COMPAT_STATE_FILE, CLAUDE_COMPAT_STATE_SCHEMA } from "./constants.ts";
import { type ManagedFiles, pruneManagedFiles, readJsonFile, writePrivateFile } from "./files.ts";
import { type HookInventoryEntry, inventoryHooks, type ResolvedHook, resolveReviewedHooks } from "./hooks.ts";
import { discoverPlugins, type SkippedPlugin } from "./plugins.ts";
import { buildSkillCatalog, nativeSkillNamesFromDirectories, type SelectedSkill, type SkillDuplicate, type SkippedSkill } from "./skills.ts";

/** Derived, regenerable import state. Local only: it must never be published. */
export interface ClaudeCompatState {
	schema: typeof CLAUDE_COMPAT_STATE_SCHEMA;
	plugins: Array<{ key: string; version: string; root: string }>;
	skippedPlugins: SkippedPlugin[];
	skills: SelectedSkill[];
	duplicates: SkillDuplicate[];
	skippedSkills: SkippedSkill[];
	agents: ConvertedAgent[];
	policies: AgentPolicy[];
	agentErrors: AgentImportError[];
	hooks: ResolvedHook[];
	hookErrors: string[];
	hookInventory: HookInventoryEntry[];
	files: ManagedFiles;
	retainedModified: string[];
}

export interface SyncLocations {
	home: string;
	agentHome: string;
	configHome: string;
	/** Skill directories Pi discovers on its own; their names keep priority. */
	nativeSkillDirectories?: readonly string[];
}

const PACKAGE_SKILLS_DIRECTORY = fileURLToPath(new URL("../../skills", import.meta.url));

export function claudeCompatStatePath(agentHome: string): string {
	return join(agentHome, CLAUDE_COMPAT_IMPORT_DIRECTORY, CLAUDE_COMPAT_STATE_FILE);
}

/** Directories Pi's package manager scans for skills regardless of this importer. */
export function defaultNativeSkillDirectories(home: string, agentHome: string): string[] {
	return [join(agentHome, "skills"), join(home, ".agents", "skills"), PACKAGE_SKILLS_DIRECTORY];
}

/** Reads the last import. Missing → undefined; a foreign schema or corrupt file throws. */
export function readClaudeCompatState(agentHome: string): ClaudeCompatState | undefined {
	const state = readJsonFile<ClaudeCompatState | undefined>(claudeCompatStatePath(agentHome), undefined);
	if (state === undefined) return undefined;
	if (state.schema !== CLAUDE_COMPAT_STATE_SCHEMA) throw new Error(`claude-compat:readClaudeCompatState failed: unsupported schema ${String(state.schema)} in ${claudeCompatStatePath(agentHome)}`);
	return state;
}

/**
 * Explicit import: reads Claude Code configuration (never writes it), derives
 * skills and agents under the Pi agent home, and records the state.
 */
export function synchronizeClaudeCompat(locations: SyncLocations): ClaudeCompatState {
	const { home, agentHome } = locations;
	const previousState = readClaudeCompatState(agentHome);
	const previous = previousState?.files ?? {};
	const config = loadClaudeCompatConfig(locations.configHome);
	const { plugins, skipped } = discoverPlugins(home, config.nativeEquivalents);
	const written: ManagedFiles = {};
	const nativeSkillNames = nativeSkillNamesFromDirectories(locations.nativeSkillDirectories ?? defaultNativeSkillDirectories(home, agentHome));
	const skills = buildSkillCatalog({ home, agentHome, plugins, nativeSkillNames, previous, written });
	const agents = buildAgentCatalog({ home, agentHome, plugins, previous, written });
	const reviewed = resolveReviewedHooks(config.hooks, plugins);
	const ownedRoots = [join(agentHome, "agents"), join(agentHome, CLAUDE_COMPAT_IMPORT_DIRECTORY)];
	const state: ClaudeCompatState = {
		schema: CLAUDE_COMPAT_STATE_SCHEMA,
		plugins: plugins.map((plugin) => ({ key: plugin.key, version: plugin.version, root: plugin.root })),
		skippedPlugins: skipped,
		skills: skills.skills,
		duplicates: skills.duplicates,
		skippedSkills: skills.skipped,
		agents: agents.agents,
		policies: agents.policies,
		agentErrors: agents.errors,
		hooks: reviewed.hooks,
		hookErrors: reviewed.errors,
		hookInventory: inventoryHooks(home, plugins, config.hooks, Object.fromEntries(skipped.filter((plugin) => config.nativeEquivalents[plugin.key.split("@")[0]]).map((plugin) => [plugin.key, config.nativeEquivalents[plugin.key.split("@")[0]]]))),
		files: written,
		retainedModified: pruneManagedFiles(previous, written, ownedRoots),
	};
	writePrivateFile(claudeCompatStatePath(agentHome), `${JSON.stringify(state, null, 2)}\n`);
	return state;
}
