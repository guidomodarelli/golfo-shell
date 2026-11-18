import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ReviewedHook } from "./config.ts";
import { HOOK_EVENT, PI_TO_CLAUDE_TOOL, type SupportedHookEvent } from "./constants.ts";
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

/** A reviewed hook bound to an installed script. */
export interface ResolvedHook {
	id: string;
	event: SupportedHookEvent;
	tools?: string[];
	script: string;
	root: string;
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

/** Binds each reviewed hook to the newest enabled install of its plugin. */
export function resolveReviewedHooks(reviewed: readonly ReviewedHook[], plugins: readonly ClaudePlugin[]): { hooks: ResolvedHook[]; errors: string[] } {
	const hooks: ResolvedHook[] = [];
	const errors: string[] = [];
	for (const hook of reviewed) {
		const plugin = plugins.find((candidate) => candidate.name === hook.plugin);
		if (!plugin) { errors.push(`${hook.id}: plugin ${hook.plugin} no habilitado o no importado`); continue; }
		if (!existsSync(join(plugin.root, hook.script))) { errors.push(`${hook.id}: script ${hook.script} no existe en ${hook.plugin}`); continue; }
		try {
			hooks.push({ id: hook.id, event: hook.event, ...(hook.tools ? { tools: hook.tools } : {}), script: pluginFile(plugin.root, hook.script), root: plugin.root });
		} catch (error) {
			errors.push(`${hook.id}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return { hooks, errors };
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

/** Minimal Pi → Claude Code payload; it never claims a Claude transcript. */
export function hookPayload(event: SupportedHookEvent, context: { cwd: string; sessionId: string }, tool?: { name: string; input: unknown; callId: string; response?: string }): Record<string, unknown> {
	return {
		hook_event_name: event,
		session_id: context.sessionId,
		cwd: context.cwd,
		...(tool ? { tool_name: PI_TO_CLAUDE_TOOL[tool.name] ?? tool.name, tool_input: tool.input, tool_use_id: tool.callId } : {}),
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

/** Whether a reviewed tool hook applies to this Pi tool. */
export function hookAppliesToTool(hook: ResolvedHook, piToolName: string): boolean {
	if (!hook.tools) return true;
	const claudeName = PI_TO_CLAUDE_TOOL[piToolName] ?? piToolName;
	return hook.tools.includes(claudeName);
}

/** Runs a reviewed hook with the Claude Code environment variables it expects. */
export async function callReviewedHook(hook: ResolvedHook, payload: Record<string, unknown>, options: { cwd: string; signal?: AbortSignal }): Promise<HookDecision> {
	const gating = hook.event === HOOK_EVENT.PRE_TOOL_USE;
	const environment = { ...process.env, CLAUDE_PLUGIN_ROOT: hook.root, CLAUDE_PROJECT_DIR: options.cwd };
	try {
		const result = await runHookScript(hook.script, payload, { cwd: options.cwd, environment, signal: options.signal });
		return decodeHookResult(result, gating);
	} catch (error) {
		if (gating) return { action: "block", reason: `claude-compat: guard ${hook.id} no pudo validar la operación (${error instanceof Error ? error.message : String(error)})` };
		throw error;
	}
}
