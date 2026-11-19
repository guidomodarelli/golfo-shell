import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { gentlePiConfigHome } from "../lib/agent-home.ts";
import { errorDetail } from "../lib/integrations/config-file.ts";
import { AGENTS_CHILD_ENV, type SessionSignalEvent } from "../lib/integrations/constants.ts";
import { deliverSignal, loadSessionSignalsConfig, sessionSignalsConfigPath, type SessionSignalsConfig, signalPayload } from "../lib/integrations/session-signals.ts";

export interface SessionSignalsDependencies {
	env?: NodeJS.ProcessEnv;
	home?: string;
	configHome?: string;
	/** Called after each delivery attempt settles; lets callers observe the queue without timers. */
	onSettled?: (event: SessionSignalEvent, error?: Error) => void;
}

/**
 * Optional session signals (golfo-shell#7): consumes Pi's native `agent_start`
 * and `agent_end` and tells an external target that a turn started or the
 * agent went idle. Without `session-signals.json` the extension does nothing.
 * A failed signal is reported once per cause and never blocks the session.
 */
export function createSessionSignalsExtension(dependencies: SessionSignalsDependencies = {}): (pi: ExtensionAPI) => void {
	return (pi) => {
		const env = dependencies.env ?? process.env;
		const home = dependencies.home ?? homedir();
		const configHome = dependencies.configHome ?? gentlePiConfigHome(env);
		const child = env[AGENTS_CHILD_ENV] === "1";
		let config: SessionSignalsConfig | undefined;
		let lifetime = new AbortController();
		// Signals of one session are delivered in order, one at a time.
		let queue: Promise<void> = Promise.resolve();
		const reported = new Set<string>();

		const report = (ctx: ExtensionContext, message: string) => {
			if (reported.has(message)) return;
			reported.add(message);
			ctx.ui.notify(message, "warning");
		};

		const send = (event: SessionSignalEvent, ctx: ExtensionContext) => {
			if (!config?.enabled || !config.events.includes(event) || (child && !config.includeChildren)) return;
			let sessionId: string;
			try { sessionId = ctx.sessionManager.getSessionId(); } catch { return; }
			const active = config;
			const signal = lifetime.signal;
			const payload = signalPayload(event, sessionId);
			queue = queue.then(async () => {
				if (signal.aborted) return;
				try {
					await deliverSignal(active, payload, { configHome, cwd: ctx.cwd, signal, home, environment: env });
					dependencies.onSettled?.(event);
				} catch (error) {
					if (!signal.aborted) report(ctx, errorDetail(error));
					dependencies.onSettled?.(event, error instanceof Error ? error : new Error(String(error)));
				}
			});
		};

		pi.on("session_start", (_event, ctx) => {
			reported.clear();
			try {
				config = loadSessionSignalsConfig(configHome);
			} catch (error) {
				config = undefined;
				ctx.ui.notify(`${errorDetail(error)}. No se envían señales hasta corregir ${sessionSignalsConfigPath(configHome)}.`, "warning");
			}
		});

		pi.on("agent_start", (_event, ctx) => send("turn_start", ctx));
		pi.on("agent_end", (_event, ctx) => send("activity_end", ctx));

		pi.on("session_shutdown", () => {
			lifetime.abort();
			lifetime = new AbortController();
			queue = Promise.resolve();
		});
	};
}

export default function sessionSignalsExtension(pi: ExtensionAPI): void {
	createSessionSignalsExtension()(pi);
}
