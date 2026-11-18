import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { gentlePiConfigHome, resolveGentlePiAgentHome } from "../lib/agent-home.ts";
import { CHILD_SKILLS_CATALOG_ENV, REQUESTED_TOOLS_ENV } from "../lib/agents-runner.ts";
import { enforceAgentPolicy, PolicyViolation, resolveChildPolicy } from "../lib/claude-compat/agent-policy.ts";
import { HOOK_CONTEXT_MESSAGE_TYPE, HOOK_EVENT, STATUS_COMMAND, SYNC_COMMAND } from "../lib/claude-compat/constants.ts";
import { markClaudeCompatGuardActive } from "../lib/claude-compat/guard-signal.ts";
import { callReviewedHook, hookAppliesToTool, hookPayload, type ResolvedHook } from "../lib/claude-compat/hooks.ts";
import { formatClaudeCompatReport } from "../lib/claude-compat/report.ts";
import { type ClaudeCompatState, readClaudeCompatState, synchronizeClaudeCompat } from "../lib/claude-compat/sync.ts";

export interface ClaudeCompatDependencies {
	env?: NodeJS.ProcessEnv;
	home?: string;
	agentHome?: string;
	configHome?: string;
}

const ASK_TITLE = "Un hook de Claude Code pide confirmación";

function block(reason: string): ToolCallEventResult {
	return { block: true, reason };
}

function hooksFor(state: ClaudeCompatState | undefined, event: string): ResolvedHook[] {
	return (state?.hooks ?? []).filter((hook) => hook.event === event);
}

function sessionIdOf(ctx: ExtensionContext): string {
	try { return ctx.sessionManager.getSessionId(); } catch { return ""; }
}

/**
 * Claude Code compatibility bridge (golfo-shell#4). Import is explicit
 * (`/claude-compat:sync`); startup only reads the derived state. The tool guard
 * is registered before anything is read, so a broken import never leaves an
 * imported agent's child unrestricted.
 */
export function createClaudeCompatExtension(dependencies: ClaudeCompatDependencies = {}): (pi: ExtensionAPI) => void {
	return (pi) => {
		const env = dependencies.env ?? process.env;
		const home = dependencies.home ?? homedir();
		const agentHome = dependencies.agentHome ?? resolveGentlePiAgentHome(env);
		const configHome = dependencies.configHome ?? gentlePiConfigHome(env);
		const child = env.GENTLE_PI_AGENTS_CHILD === "1";
		let state: ClaudeCompatState | undefined;
		let loadError: string | undefined;
		let pendingContext: string[] = [];

		pi.on("tool_call", async (event, ctx) => {
			const input = (event.input ?? {}) as Record<string, unknown>;
			try {
				// Policies are undefined when the state failed to load, so an
				// imported child is refused instead of running unrestricted.
				const policy = resolveChildPolicy(env, REQUESTED_TOOLS_ENV, loadError ? undefined : state?.policies ?? []);
				if (policy) enforceAgentPolicy(policy, event.toolName, input);
			} catch (error) {
				const detail = error instanceof PolicyViolation ? error.message : `no se pudo validar la política (${error instanceof Error ? error.message : String(error)})`;
				return block(`claude-compat: ${detail}`);
			}
			for (const hook of hooksFor(state, HOOK_EVENT.PRE_TOOL_USE).filter((candidate) => hookAppliesToTool(candidate, event.toolName))) {
				const payload = hookPayload(HOOK_EVENT.PRE_TOOL_USE, { cwd: ctx.cwd, sessionId: sessionIdOf(ctx) }, { name: event.toolName, input, callId: event.toolCallId });
				const decision = await callReviewedHook(hook, payload, { cwd: ctx.cwd, signal: ctx.signal });
				if (decision.action === "block") return block(decision.reason);
				if (decision.action === "ask") {
					// `ask` keeps its meaning: a human confirms. Children and headless runs cannot.
					if (child || !ctx.hasUI) return block(`claude-compat: ${decision.reason} (requiere confirmación humana; no disponible en esta sesión)`);
					const approved = await ctx.ui.confirm(ASK_TITLE, `${hook.id}: ${decision.reason}`);
					if (!approved) return block(`claude-compat: confirmación rechazada para ${hook.id}`);
				}
			}
			return undefined;
		});
		markClaudeCompatGuardActive();

		try {
			state = readClaudeCompatState(agentHome);
		} catch (error) {
			loadError = error instanceof Error ? error.message : String(error);
		}

		// Hidden markers bind a child to its policy through its exact --tools list.
		for (const policy of state?.policies ?? []) {
			pi.registerTool({
				name: policy.marker,
				label: policy.name,
				description: "Marcador interno de política de claude-compat; no tiene efectos.",
				exposure: "hidden",
				defaultActive: false,
				parameters: Type.Object({}, { additionalProperties: false }),
				async execute() {
					return { content: [{ type: "text", text: policy.name }], details: {} };
				},
			});
		}

		pi.on("resources_discover", () => {
			if (!state || loadError || env[CHILD_SKILLS_CATALOG_ENV] === "1") return undefined;
			const imported = new Set(state.skills.map((skill) => skill.file));
			// Names Pi already loaded natively (project skills included) keep priority.
			const native = new Set(pi.getCommands()
				.filter((command) => command.source === "skill" && !imported.has(command.sourceInfo?.path ?? ""))
				.map((command) => command.name.replace(/^skill:/, "")));
			const skillPaths = state.skills.filter((skill) => !native.has(skill.name) && existsSync(skill.file)).map((skill) => skill.file);
			return skillPaths.length > 0 ? { skillPaths } : undefined;
		});

		const collectContext = async (ctx: ExtensionContext, source: string) => {
			for (const hook of hooksFor(state, HOOK_EVENT.SESSION_START)) {
				try {
					const decision = await callReviewedHook(hook, { ...hookPayload(HOOK_EVENT.SESSION_START, { cwd: ctx.cwd, sessionId: sessionIdOf(ctx) }), source }, { cwd: ctx.cwd });
					if (decision.action === "continue" && decision.context) pendingContext.push(decision.context);
				} catch (error) {
					ctx.ui.notify(`claude-compat: el hook ${hook.id} no aportó contexto (${error instanceof Error ? error.message : String(error)})`, "warning");
				}
			}
		};

		pi.on("session_start", async (event, ctx) => {
			pendingContext = [];
			if (loadError) ctx.ui.notify(`claude-compat: importación ilegible; los agentes importados quedan bloqueados hasta corregirla. ${loadError}`, "warning");
			await collectContext(ctx, event.reason === "new" ? "clear" : event.reason);
		});

		pi.on("session_compact", async (_event, ctx) => {
			await collectContext(ctx, "compact");
		});

		pi.on("before_agent_start", () => {
			if (pendingContext.length === 0) return undefined;
			const content = pendingContext.join("\n\n");
			pendingContext = [];
			return { message: { customType: HOOK_CONTEXT_MESSAGE_TYPE, content, display: false } };
		});

		pi.on("tool_result", async (event, ctx) => {
			if (event.isError) return undefined;
			const additions: string[] = [];
			for (const hook of hooksFor(state, HOOK_EVENT.POST_TOOL_USE).filter((candidate) => hookAppliesToTool(candidate, event.toolName))) {
				try {
					const response = event.content.filter((part) => part.type === "text").map((part) => (part as { text: string }).text).join("\n");
					const payload = hookPayload(HOOK_EVENT.POST_TOOL_USE, { cwd: ctx.cwd, sessionId: sessionIdOf(ctx) }, { name: event.toolName, input: event.input, callId: event.toolCallId, response });
					const decision = await callReviewedHook(hook, payload, { cwd: ctx.cwd, signal: ctx.signal });
					if (decision.action === "continue" && decision.context) additions.push(decision.context);
					else if (decision.action !== "continue") additions.push(`[claude-compat] ${hook.id}: ${decision.reason}`);
				} catch (error) {
					ctx.ui.notify(`claude-compat: el hook ${hook.id} falló tras ${event.toolName} (${error instanceof Error ? error.message : String(error)})`, "warning");
				}
			}
			return additions.length > 0 ? { content: [...event.content, ...additions.map((text) => ({ type: "text" as const, text }))] } : undefined;
		});

		if (child) return;

		pi.registerCommand(SYNC_COMMAND, {
			description: "Importar skills, agentes y hooks revisados de Claude Code (no modifica la configuración de Claude Code) y recargar.",
			async handler(_args, ctx) {
				try {
					const next = synchronizeClaudeCompat({ home, agentHome, configHome });
					ctx.ui.notify(formatClaudeCompatReport(next), "info");
				} catch (error) {
					ctx.ui.notify(`claude-compat: la importación falló y no se aplicó (${error instanceof Error ? error.message : String(error)})`, "error");
					return;
				}
				await ctx.reload();
			},
		});

		pi.registerCommand(STATUS_COMMAND, {
			description: "Mostrar qué se importó de Claude Code, duplicados, equivalentes nativos y capacidades pendientes.",
			async handler(_args, ctx) {
				if (loadError) { ctx.ui.notify(`claude-compat: estado ilegible: ${loadError}`, "error"); return; }
				ctx.ui.notify(state ? formatClaudeCompatReport(state) : `claude-compat: no hay importación. Ejecutar /${SYNC_COMMAND}.`, "info");
			},
		});
	};
}

export default function claudeCompatExtension(pi: ExtensionAPI): void {
	createClaudeCompatExtension()(pi);
}
