import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { BASH_BACKGROUND_TOOL, MONITOR_TOOL, SHELL_COMMAND_TOOLS } from "../background-jobs.ts";
import { piMcpToolName } from "./agents.ts";
import type { ReviewedHook } from "./config.ts";
import { HOOK_EVENT, MCP_SEGMENT_SEPARATOR, MCP_TOOL_PREFIX, PI_BASH_TOOL, PI_TO_CLAUDE_TOOL, type SupportedHookEvent } from "./constants.ts";
import { pluginFile, readJsonFile } from "./files.ts";
import { type ClaudePlugin, readClaudeSettings } from "./plugins.ts";
import { runHookScript } from "./process.ts";

/** Claude Code hook events Gentle Shell already covers natively. */
export const NATIVE_HOOK_EVENTS: Readonly<Record<string, string>> = {
	Notification: "notificaciones nativas de Gentle Shell (gentle-notifications)",
	PreCompact: "compactación nativa de Pi",
};

export type HookClassification = "adapted" | "native-equivalent" | "pending";

/** One hook found in Claude Code configuration, with how the import treats it. */
export interface HookInventoryEntry {
	origin: string;
	event: string;
	command: string;
	classification: HookClassification;
	reason: string;
}

/**
 * A reviewed hook bound to an installed script. A reviewed `PreToolUse` guard
 * whose script cannot be resolved is kept without `script` and with
 * `unavailable` set, so the calls it matches fail closed instead of running
 * unguarded.
 */
export interface ResolvedHook {
	id: string;
	event: SupportedHookEvent;
	tools?: string[];
	script?: string;
	root?: string;
	/** Why the reviewed guard could not be bound; such a guard blocks every call it matches. */
	unavailable?: string;
}

interface HookCommand { type?: string; command?: string }
interface HookGroup { matcher?: string; hooks?: HookCommand[] }
type HookMap = Record<string, HookGroup[]>;

function hookMapOf(value: unknown): HookMap {
	const hooks = value && typeof value === "object" && !Array.isArray(value) ? (value as { hooks?: unknown }).hooks ?? value : {};
	return hooks && typeof hooks === "object" && !Array.isArray(hooks) ? hooks as HookMap : {};
}

function pluginHookMap(plugin: ClaudePlugin): HookMap {
	const declared = plugin.manifest.hooks;
	if (declared && typeof declared === "object") return hookMapOf(declared);
	const relativePath = typeof declared === "string" ? declared : join("hooks", "hooks.json");
	try {
		const file = pluginFile(plugin.root, relativePath);
		return hookMapOf(readJsonFile<unknown>(file, {}));
	} catch {
		return {};
	}
}

function commandReferencesScript(command: string, script: string): boolean {
	const normalized = script.replaceAll("\\", "/").replace(/^\.\//, "");
	return command.replaceAll("\\", "/").includes(normalized);
}

/**
 * Binds each reviewed hook to the newest enabled install of its plugin. An
 * unresolvable `PreToolUse` guard stays in `hooks` as a blocking entry (fail
 * closed); unresolvable context hooks are only reported in `errors`.
 */
export function resolveReviewedHooks(reviewed: readonly ReviewedHook[], plugins: readonly ClaudePlugin[]): { hooks: ResolvedHook[]; errors: string[] } {
	const hooks: ResolvedHook[] = [];
	const errors: string[] = [];
	const unresolved = (hook: ReviewedHook, reason: string) => {
		errors.push(`${hook.id}: ${reason}`);
		if (hook.event === HOOK_EVENT.PRE_TOOL_USE) hooks.push({ id: hook.id, event: hook.event, ...(hook.tools ? { tools: hook.tools } : {}), unavailable: reason });
	};
	for (const hook of reviewed) {
		const plugin = plugins.find((candidate) => candidate.name === hook.plugin);
		if (!plugin) { unresolved(hook, `plugin ${hook.plugin} no habilitado o no importado`); continue; }
		if (!existsSync(join(plugin.root, hook.script))) { unresolved(hook, `script ${hook.script} no existe en ${hook.plugin}`); continue; }
		try {
			hooks.push({ id: hook.id, event: hook.event, ...(hook.tools ? { tools: hook.tools } : {}), script: pluginFile(plugin.root, hook.script), root: plugin.root });
		} catch (error) {
			unresolved(hook, error instanceof Error ? error.message : String(error));
		}
	}
	return { hooks, errors };
}

/** Block reason for a reviewed guard that could not be bound to its script. */
export function unavailableGuardReason(hook: ResolvedHook): string {
	return `claude-compat: guard ${hook.id} no disponible (${hook.unavailable ?? "sin script resuelto"}); no se ejecutó la operación. Restaurar el plugin o quitar el hook de claude-compat.json y ejecutar la sincronización`;
}

/**
 * Inventory of every plugin and user hook. Only reviewed scripts are adapted;
 * native equivalents and the rest are reported separately and never run.
 */
export function inventoryHooks(home: string, plugins: readonly ClaudePlugin[], reviewed: readonly ReviewedHook[], nativeEquivalentPlugins: Readonly<Record<string, string>>): HookInventoryEntry[] {
	const entries: HookInventoryEntry[] = [];
	const classify = (origin: string, pluginName: string | undefined, event: string, command: string): HookInventoryEntry => {
		const match = pluginName ? reviewed.find((hook) => hook.plugin === pluginName && hook.event === event && commandReferencesScript(command, hook.script)) : undefined;
		if (match) return { origin, event, command, classification: "adapted", reason: `adaptador revisado ${match.id}` };
		if (NATIVE_HOOK_EVENTS[event]) return { origin, event, command, classification: "native-equivalent", reason: NATIVE_HOOK_EVENTS[event] };
		return { origin, event, command, classification: "pending", reason: pluginName ? "sin adaptador revisado en claude-compat.json" : "hook de settings.json: comando arbitrario, no se ejecuta" };
	};
	const seenPlugins = new Set<string>();
	for (const plugin of plugins) {
		if (seenPlugins.has(plugin.key)) continue;
		seenPlugins.add(plugin.key);
		for (const [event, groups] of Object.entries(pluginHookMap(plugin))) {
			for (const group of Array.isArray(groups) ? groups : []) {
				for (const hook of group.hooks ?? []) entries.push(classify(plugin.key, plugin.name, event, String(hook.command ?? hook.type ?? "")));
			}
		}
	}
	for (const [plugin, reason] of Object.entries(nativeEquivalentPlugins)) {
		entries.push({ origin: plugin, event: "*", command: "", classification: "native-equivalent", reason });
	}
	for (const [event, groups] of Object.entries(hookMapOf(readClaudeSettings(home).hooks))) {
		for (const group of Array.isArray(groups) ? groups : []) {
			for (const hook of group.hooks ?? []) entries.push(classify("~/.claude/settings.json", undefined, event, String(hook.command ?? hook.type ?? "")));
		}
	}
	return entries;
}

/** Claude Code tool names a translated Pi call can produce. */
const CLAUDE_TOOL = {
	BASH: "Bash",
	READ: "Read",
	WRITE: "Write",
	EDIT: "Edit",
	MULTI_EDIT: "MultiEdit",
	GREP: "Grep",
	GLOB: "Glob",
	LS: "LS",
} as const satisfies Record<string, string>;

const MILLISECONDS_PER_SECOND = 1000;

/** A Pi tool call expressed with Claude Code's tool name and `tool_input` field names. */
export interface ClaudeToolCall {
	toolName: string;
	input: Record<string, unknown>;
}

type InputRecord = Record<string, unknown>;
interface PiEdit { oldText: string; newText: string }

function isRecord(value: unknown): value is InputRecord {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isOptional(value: unknown, type: "string" | "number" | "boolean"): boolean {
	return value === undefined || typeof value === type;
}

/** Claude Code always sends absolute paths; Pi also accepts `@`, `~` and cwd-relative ones. */
function absolutePath(filePath: string, cwd: string): string {
	const unprefixed = filePath.startsWith("@") ? filePath.slice(1) : filePath;
	const expanded = unprefixed === "~" || /^~[\\/]/.test(unprefixed) ? join(homedir(), unprefixed.slice(1)) : unprefixed;
	return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

function withoutUndefined(fields: InputRecord): InputRecord {
	return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

function editsOf(input: InputRecord): PiEdit[] | undefined {
	// Pi still accepts the legacy single-edit form (top-level oldText/newText).
	const edits = input.edits === undefined && input.oldText !== undefined ? [{ oldText: input.oldText, newText: input.newText }] : input.edits;
	if (!Array.isArray(edits) || edits.length === 0) return undefined;
	return edits.every((edit) => isRecord(edit) && typeof edit.oldText === "string" && typeof edit.newText === "string") ? edits as PiEdit[] : undefined;
}

/**
 * Claude Code tool name for a Pi tool, or `undefined` when it has none. Every
 * tool that runs a shell command is `Bash`, so a reviewed Bash guard cannot be
 * bypassed by launching the same command through a background tool.
 */
function claudeToolNameOf(piToolName: string): string | undefined {
	return SHELL_COMMAND_TOOLS.has(piToolName) ? CLAUDE_TOOL.BASH : PI_TO_CLAUDE_TOOL[piToolName];
}

/**
 * Translates a Pi tool call into the `tool_name`/`tool_input` a Claude Code
 * hook expects: `path` → absolute `file_path`, Pi edits → `Edit` (one) or
 * `MultiEdit` (several), bash timeout seconds → milliseconds, and every shell
 * command tool (`bash_background`, `monitor`) → `Bash` with
 * `run_in_background: true`, so a reviewed Bash guard sees them all. Returns
 * `undefined` when a known tool's input does not have the shape Pi declares,
 * so callers fail closed instead of handing a reviewed hook fields it would not
 * recognize. Tools without a Claude Code counterpart keep their name and input.
 */
export function translateToolInput(piToolName: string, input: unknown, cwd: string): ClaudeToolCall | undefined {
	if (!isRecord(input)) return undefined;
	const claudeName = claudeToolNameOf(piToolName);
	switch (claudeName) {
		case undefined:
			return { toolName: piToolName, input };
		case CLAUDE_TOOL.READ:
			if (typeof input.path !== "string" || !isOptional(input.offset, "number") || !isOptional(input.limit, "number")) return undefined;
			return { toolName: claudeName, input: withoutUndefined({ file_path: absolutePath(input.path, cwd), offset: input.offset, limit: input.limit }) };
		case CLAUDE_TOOL.WRITE:
			if (typeof input.path !== "string" || typeof input.content !== "string") return undefined;
			return { toolName: claudeName, input: { file_path: absolutePath(input.path, cwd), content: input.content } };
		case CLAUDE_TOOL.EDIT: {
			const edits = editsOf(input);
			if (typeof input.path !== "string" || !edits) return undefined;
			const filePath = absolutePath(input.path, cwd);
			if (edits.length === 1) return { toolName: CLAUDE_TOOL.EDIT, input: { file_path: filePath, old_string: edits[0].oldText, new_string: edits[0].newText } };
			return { toolName: CLAUDE_TOOL.MULTI_EDIT, input: { file_path: filePath, edits: edits.map((edit) => ({ old_string: edit.oldText, new_string: edit.newText })) } };
		}
		case CLAUDE_TOOL.BASH: {
			const timeoutSeconds = piToolName === MONITOR_TOOL ? input.timeout_seconds : piToolName === BASH_BACKGROUND_TOOL ? undefined : input.timeout;
			if (typeof input.command !== "string" || !isOptional(timeoutSeconds, "number")) return undefined;
			return { toolName: claudeName, input: withoutUndefined({
				command: input.command,
				timeout: typeof timeoutSeconds === "number" ? timeoutSeconds * MILLISECONDS_PER_SECOND : undefined,
				run_in_background: piToolName === PI_BASH_TOOL ? undefined : true,
			}) };
		}
		case CLAUDE_TOOL.GREP:
			if (typeof input.pattern !== "string" || !isOptional(input.path, "string") || !isOptional(input.glob, "string") || !isOptional(input.ignoreCase, "boolean") || !isOptional(input.context, "number") || !isOptional(input.limit, "number")) return undefined;
			return { toolName: claudeName, input: withoutUndefined({ pattern: input.pattern, path: typeof input.path === "string" ? absolutePath(input.path, cwd) : undefined, glob: input.glob, "-i": input.ignoreCase, "-C": input.context, head_limit: input.limit }) };
		case CLAUDE_TOOL.GLOB:
			if (typeof input.pattern !== "string" || !isOptional(input.path, "string")) return undefined;
			return { toolName: claudeName, input: withoutUndefined({ pattern: input.pattern, path: typeof input.path === "string" ? absolutePath(input.path, cwd) : undefined }) };
		case CLAUDE_TOOL.LS:
			if (!isOptional(input.path, "string")) return undefined;
			return { toolName: claudeName, input: { path: absolutePath(typeof input.path === "string" ? input.path : ".", cwd) } };
		default:
			return { toolName: claudeName, input };
	}
}

/**
 * Minimal Pi → Claude Code payload; it never claims a Claude transcript.
 * `tool` must already be translated with {@link translateToolInput}.
 */
export function hookPayload(event: SupportedHookEvent, context: { cwd: string; sessionId: string }, tool?: ClaudeToolCall & { callId: string; response?: string }): Record<string, unknown> {
	return {
		hook_event_name: event,
		session_id: context.sessionId,
		cwd: context.cwd,
		...(tool ? { tool_name: tool.toolName, tool_input: tool.input, tool_use_id: tool.callId } : {}),
		...(tool?.response !== undefined ? { tool_response: tool.response } : {}),
	};
}

export type HookDecision =
	| { action: "continue"; context?: string }
	| { action: "ask"; reason: string }
	| { action: "block"; reason: string };

const PERMISSION_DECISIONS = ["allow", "deny", "ask"];

function reasonOf(data: Record<string, unknown>, specific: Record<string, unknown>, fallback: string): string {
	const reason = specific.permissionDecisionReason ?? data.reason ?? data.stopReason;
	return typeof reason === "string" && reason.trim() ? reason.trim().slice(0, 500) : fallback;
}

/**
 * Decodes a hook result. Gating hooks fail closed (non-zero exit, invalid or
 * unknown output → block); `allow` only means "no objection" and the host's
 * own consent still applies. Context hooks throw on any contract violation.
 */
export function decodeHookResult(result: { code: number; stdout: string; stderr: string }, gating: boolean): HookDecision {
	const failure = (detail: string): HookDecision => {
		if (gating) return { action: "block", reason: `claude-compat: guard ${detail}; no se ejecutó la operación` };
		throw new Error(`claude-compat:decodeHookResult failed: hook de contexto ${detail}`);
	};
	if (result.code !== 0) {
		const stderr = result.stderr.trim().slice(0, 500);
		return failure(`terminó con código ${result.code}${stderr ? `: ${stderr}` : ""}`);
	}
	if (!result.stdout.trim()) return { action: "continue" };
	let data: unknown;
	try { data = JSON.parse(result.stdout); }
	catch { return failure("devolvió JSON inválido"); }
	if (!data || typeof data !== "object" || Array.isArray(data)) return failure("devolvió una respuesta fuera de contrato");
	const record = data as Record<string, unknown>;
	const specific = (record.hookSpecificOutput ?? {}) as Record<string, unknown>;
	if (!specific || typeof specific !== "object" || Array.isArray(specific)) return failure("devolvió hookSpecificOutput fuera de contrato");
	if (specific.permissionDecision !== undefined && !PERMISSION_DECISIONS.includes(specific.permissionDecision as string)) return failure("devolvió una decisión desconocida");
	if (record.continue !== undefined && typeof record.continue !== "boolean") return failure("devolvió continue fuera de contrato");
	if (record.decision !== undefined && !["approve", "block"].includes(record.decision as string)) return failure("devolvió decision fuera de contrato");
	if (gating && specific.updatedInput !== undefined) return failure("intentó reescribir la entrada (updatedInput no está soportado)");
	if (record.continue === false || record.decision === "block" || specific.permissionDecision === "deny") {
		return { action: "block", reason: `claude-compat: ${reasonOf(record, specific, "un hook revisado rechazó la operación")}` };
	}
	if (specific.permissionDecision === "ask") return { action: "ask", reason: reasonOf(record, specific, "un hook revisado pide confirmación") };
	const context = typeof specific.additionalContext === "string" && specific.additionalContext.trim() ? specific.additionalContext : undefined;
	return { action: "continue", ...(context ? { context } : {}) };
}

/** Claude Code names one concept with two tools: a matcher for either covers both. */
const EQUIVALENT_CLAUDE_TOOLS: Readonly<Record<string, readonly string[]>> = {
	[CLAUDE_TOOL.EDIT]: [CLAUDE_TOOL.EDIT, CLAUDE_TOOL.MULTI_EDIT],
	[CLAUDE_TOOL.MULTI_EDIT]: [CLAUDE_TOOL.EDIT, CLAUDE_TOOL.MULTI_EDIT],
};

/**
 * Whether a Claude Code MCP matcher (`mcp__dev-docs__publish`, or the whole
 * server `mcp__dev-docs`) covers a Pi MCP tool, whose server Pi normalizes
 * (`mcp__dev_docs__publish`).
 */
function mcpMatcherCovers(matcher: string, piToolName: string): boolean {
	if (!matcher.startsWith(MCP_TOOL_PREFIX) || !piToolName.startsWith(MCP_TOOL_PREFIX)) return false;
	const normalizedMatcher = piMcpToolName(matcher);
	return piToolName === normalizedMatcher || piToolName.startsWith(`${normalizedMatcher}${MCP_SEGMENT_SEPARATOR}`);
}

/** Whether a reviewed tool hook applies to this Pi tool. */
export function hookAppliesToTool(hook: ResolvedHook, piToolName: string): boolean {
	if (!hook.tools) return true;
	const claudeName = claudeToolNameOf(piToolName) ?? piToolName;
	const names = EQUIVALENT_CLAUDE_TOOLS[claudeName] ?? [claudeName];
	return hook.tools.some((tool) => names.includes(tool) || mcpMatcherCovers(tool, piToolName));
}

/**
 * The `tool_name` a reviewed hook receives: the exact Claude Code MCP name it
 * was configured with when that name is the one Pi normalized into
 * `piToolName`, so a hook comparing `tool_name` keeps recognizing its tool.
 */
export function claudeToolNameForHook(hook: ResolvedHook, piToolName: string): string {
	return hook.tools?.find((tool) => tool.startsWith(MCP_TOOL_PREFIX) && piMcpToolName(tool) === piToolName) ?? piToolName;
}

/** Runs a reviewed hook with the Claude Code environment variables it expects. */
export async function callReviewedHook(hook: ResolvedHook, payload: Record<string, unknown>, options: { cwd: string; signal?: AbortSignal }): Promise<HookDecision> {
	const gating = hook.event === HOOK_EVENT.PRE_TOOL_USE;
	if (hook.unavailable !== undefined || !hook.script || !hook.root) {
		if (gating) return { action: "block", reason: unavailableGuardReason(hook) };
		throw new Error(`claude-compat:callReviewedHook failed: hook ${hook.id} no disponible (${hook.unavailable ?? "sin script resuelto"})`);
	}
	const environment = { ...process.env, CLAUDE_PLUGIN_ROOT: hook.root, CLAUDE_PROJECT_DIR: options.cwd };
	try {
		const result = await runHookScript(hook.script, payload, { cwd: options.cwd, environment, signal: options.signal });
		return decodeHookResult(result, gating);
	} catch (error) {
		if (gating) return { action: "block", reason: `claude-compat: guard ${hook.id} no pudo validar la operación (${error instanceof Error ? error.message : String(error)})` };
		throw error;
	}
}
