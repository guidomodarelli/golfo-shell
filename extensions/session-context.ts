import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { gentlePiConfigHome } from "../lib/agent-home.ts";
import { errorDetail } from "../lib/integrations/config-file.ts";
import { AGENTS_CHILD_ENV, SESSION_CONTEXT, type SessionContextTrigger } from "../lib/integrations/constants.ts";
import { disabledEntries, entriesToDeliver, isEntryDisabled, loadSessionContextConfig, sessionContextConfigPath, type SessionContextConfig, type SessionContextDetails, type SessionContextToggle, triggerForStart } from "../lib/integrations/session-context.ts";
import { PendingContext } from "../lib/pending-context.ts";

export interface SessionContextDependencies {
	env?: NodeJS.ProcessEnv;
	home?: string;
	configHome?: string;
}

const OFF_ARGUMENT = "off";
const ON_ARGUMENT = "on";

/**
 * Optional declarative session context (golfo-shell#7): static text from
 * `session-context.json`, delivered as hidden context on session start and
 * after compaction. Without that file the extension does nothing.
 */
export function createSessionContextExtension(dependencies: SessionContextDependencies = {}): (pi: ExtensionAPI) => void {
	return (pi) => {
		const env = dependencies.env ?? process.env;
		const home = dependencies.home ?? homedir();
		const configHome = dependencies.configHome ?? gentlePiConfigHome(env);
		const child = env[AGENTS_CHILD_ENV] === "1";
		const pending = new PendingContext<SessionContextDetails>(SESSION_CONTEXT.MESSAGE_TYPE);
		let config: SessionContextConfig | undefined;
		let configError: string | undefined;
		let cycleTrigger: SessionContextTrigger = "startup";

		const reloadConfig = () => {
			try {
				config = loadSessionContextConfig(configHome, home);
				configError = undefined;
			} catch (error) {
				config = undefined;
				configError = errorDetail(error);
			}
		};

		const queue = (ctx: ExtensionContext, trigger: SessionContextTrigger) => {
			if (!config || (child && !config.includeChildren)) return;
			const queued = new Set(pending.queuedDetails().map((details) => details.id));
			for (const entry of entriesToDeliver(config, trigger, ctx.sessionManager.getBranch(), queued)) pending.add(entry.text, { id: entry.id });
		};

		pi.on("session_start", (event, ctx) => {
			pending.reset();
			reloadConfig();
			if (configError) {
				ctx.ui.notify(`${configError}. No se inyecta contexto de sesión hasta corregir ${sessionContextConfigPath(configHome)}.`, "warning");
				return;
			}
			cycleTrigger = triggerForStart(event.reason);
			queue(ctx, cycleTrigger);
		});

		pi.on("session_compact", (_event, ctx) => {
			cycleTrigger = "compact";
			queue(ctx, cycleTrigger);
		});

		pi.on("before_agent_start", () => pending.take());

		if (child) return;

		pi.registerCommand(SESSION_CONTEXT.COMMAND, {
			description: "Contexto declarativo de sesión: sin argumentos muestra el estado; `off [id]` lo desactiva en esta sesión y `on [id]` lo reactiva.",
			async handler(args, ctx) {
				const [action, id] = args.trim().split(/\s+/).filter(Boolean);
				if (action === OFF_ARGUMENT || action === ON_ARGUMENT) {
					if (id && !config?.entries.some((entry) => entry.id === id)) {
						ctx.ui.notify(`session-context: no hay una entrada configurada con id ${id}`, "error");
						return;
					}
					const toggle: SessionContextToggle = { disabled: action === OFF_ARGUMENT, ...(id ? { id } : {}) };
					pi.appendEntry<SessionContextToggle>(SESSION_CONTEXT.STATE_ENTRY_TYPE, toggle);
					const state = disabledEntries(ctx.sessionManager.getBranch());
					pending.retain((details) => !isEntryDisabled(state, details.id));
					if (!toggle.disabled) queue(ctx, cycleTrigger);
					ctx.ui.notify(`session-context: ${id ?? "todo el contexto"} ${toggle.disabled ? "desactivado" : "reactivado"} en esta sesión${toggle.disabled ? " (también tras compactar o recargar, hasta `/session-context on`)" : ""}`, "info");
					return;
				}
				if (action) {
					ctx.ui.notify(`session-context: argumento desconocido ${action}; usar ${OFF_ARGUMENT} [id] u ${ON_ARGUMENT} [id]`, "error");
					return;
				}
				ctx.ui.notify(formatStatus(ctx), configError ? "error" : "info");
			},
		});

		const formatStatus = (ctx: ExtensionContext): string => {
			if (configError) return `session-context: configuración inválida: ${configError}`;
			if (!config) return `session-context: inactivo (no existe ${sessionContextConfigPath(configHome)})`;
			if (!config.enabled) return "session-context: desactivado en la configuración (enabled: false)";
			const state = disabledEntries(ctx.sessionManager.getBranch());
			const lines = config.entries.map((entry) => `- ${entry.id} (${entry.on.join(", ")})${isEntryDisabled(state, entry.id) ? ": desactivada en esta sesión" : ""}`);
			return ["session-context: activo", ...(lines.length > 0 ? lines : ["- sin entradas"])].join("\n");
		};
	};
}

export default function sessionContextExtension(pi: ExtensionAPI): void {
	createSessionContextExtension()(pi);
}
