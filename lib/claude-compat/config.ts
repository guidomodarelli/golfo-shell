import { isAbsolute, join } from "node:path";
import { CLAUDE_COMPAT_CONFIG_FILE, CLAUDE_COMPAT_CONFIG_SCHEMA, DEFAULT_NATIVE_EQUIVALENTS, type SupportedHookEvent, SUPPORTED_HOOK_EVENTS } from "./constants.ts";
import { readJsonFile } from "./files.ts";

/** One hook script the user reviewed and whose contract the adapter translates. */
export interface ReviewedHook {
	id: string;
	/** Plugin name (without `@marketplace`). */
	plugin: string;
	/** Script path relative to the plugin root. */
	script: string;
	event: SupportedHookEvent;
	/** Claude Code tool names the hook applies to (PreToolUse/PostToolUse); absent means every tool. */
	tools?: string[];
}

export interface ClaudeCompatConfig {
	hooks: ReviewedHook[];
	nativeEquivalents: Record<string, string>;
}

export function claudeCompatConfigPath(configHome: string): string {
	return join(configHome, CLAUDE_COMPAT_CONFIG_FILE);
}

function invalid(path: string, detail: string): Error {
	return new Error(`claude-compat:loadClaudeCompatConfig failed: ${path}: ${detail}`);
}

function stringList(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}

/**
 * Reads `claude-compat.json`. A missing file means "no reviewed hooks"; any
 * malformed entry rejects the whole file so no hook runs under a guessed contract.
 */
export function loadClaudeCompatConfig(configHome: string): ClaudeCompatConfig {
	const path = claudeCompatConfigPath(configHome);
	const raw = readJsonFile<Record<string, unknown> | null>(path, null);
	if (raw === null) return { hooks: [], nativeEquivalents: { ...DEFAULT_NATIVE_EQUIVALENTS } };
	if (typeof raw !== "object" || Array.isArray(raw)) throw invalid(path, "expected a JSON object");
	if (raw.schema !== CLAUDE_COMPAT_CONFIG_SCHEMA) throw invalid(path, `schema must be "${CLAUDE_COMPAT_CONFIG_SCHEMA}"`);
	const hooks: ReviewedHook[] = [];
	const identifiers = new Set<string>();
	for (const [index, entry] of (Array.isArray(raw.hooks) ? raw.hooks : raw.hooks === undefined ? [] : [null]).entries()) {
		const hook = entry as Record<string, unknown> | null;
		if (!hook || typeof hook !== "object") throw invalid(path, `hooks[${index}] must be an object`);
		const { id, plugin, script, event, tools } = hook;
		if (typeof id !== "string" || !id || identifiers.has(id)) throw invalid(path, `hooks[${index}].id must be a unique non-empty string`);
		if (typeof plugin !== "string" || !plugin) throw invalid(path, `hooks[${index}].plugin must be a non-empty string`);
		if (typeof script !== "string" || !script || isAbsolute(script) || script.split(/[\\/]/).includes("..")) throw invalid(path, `hooks[${index}].script must be a path relative to the plugin root`);
		if (!(SUPPORTED_HOOK_EVENTS as readonly unknown[]).includes(event)) throw invalid(path, `hooks[${index}].event must be one of ${SUPPORTED_HOOK_EVENTS.join(", ")}`);
		if (tools !== undefined && !stringList(tools)) throw invalid(path, `hooks[${index}].tools must be a list of Claude Code tool names`);
		identifiers.add(id);
		hooks.push({ id, plugin, script, event: event as SupportedHookEvent, ...(tools ? { tools: tools as string[] } : {}) });
	}
	const nativeEquivalents: Record<string, string> = { ...DEFAULT_NATIVE_EQUIVALENTS };
	if (raw.nativeEquivalents !== undefined) {
		if (!raw.nativeEquivalents || typeof raw.nativeEquivalents !== "object" || Array.isArray(raw.nativeEquivalents)) throw invalid(path, "nativeEquivalents must map plugin names to a reason");
		for (const [plugin, reason] of Object.entries(raw.nativeEquivalents)) {
			if (typeof reason !== "string") throw invalid(path, `nativeEquivalents.${plugin} must be a string`);
			if (reason) nativeEquivalents[plugin] = reason;
			else delete nativeEquivalents[plugin];
		}
	}
	return { hooks, nativeEquivalents };
}
