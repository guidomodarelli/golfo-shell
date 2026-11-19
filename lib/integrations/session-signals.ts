import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { resolveExecutable, runProcess } from "../claude-compat/process.ts";
import { type ConfigRecord, errorDetail, IntegrationConfigError, isRecord, optionalBoolean, readIntegrationConfig, resolveConfiguredPath } from "./config-file.ts";
import { HTTP_TARGET_PROTOCOLS, SESSION_SIGNAL_EVENTS, SESSION_SIGNAL_TARGET_TYPES, SESSION_SIGNALS, type SessionSignalEvent } from "./constants.ts";

const INTEGRATION = "session-signals";

/** Executable that receives the payload as JSON on stdin; it never runs through a shell. */
export interface CommandSignalTarget {
	type: "command";
	/** Absolute path, `~/…`, a path relative to the config home, or a bare name looked up on absolute PATH entries. */
	command: string;
	args: string[];
}

/** HTTP endpoint that receives the payload as a JSON `POST`. */
export interface HttpSignalTarget {
	type: "http";
	url: string;
}

export type SessionSignalTarget = CommandSignalTarget | HttpSignalTarget;

export interface SessionSignalsConfig {
	enabled: boolean;
	includeChildren: boolean;
	events: SessionSignalEvent[];
	target: SessionSignalTarget;
	timeoutMs: number;
}

/**
 * The only data a target ever receives: no transcript, prompt, tool data,
 * credentials or configuration, and nothing that claims to be Claude Code.
 */
export interface SessionSignalPayload {
	schema: typeof SESSION_SIGNALS.PAYLOAD_SCHEMA;
	event: SessionSignalEvent;
	sessionId: string;
	timestamp: string;
}

export function sessionSignalsConfigPath(configHome: string): string {
	return join(configHome, SESSION_SIGNALS.CONFIG_FILE);
}

function invalid(detail: string): IntegrationConfigError {
	return new IntegrationConfigError(`${INTEGRATION}: ${detail}`);
}

function parseTarget(value: unknown): SessionSignalTarget {
	if (!isRecord(value) || !(SESSION_SIGNAL_TARGET_TYPES as readonly unknown[]).includes(value.type)) throw invalid(`target.type debe ser uno de ${SESSION_SIGNAL_TARGET_TYPES.join(", ")}`);
	if (value.type === "http") {
		let url: URL;
		try { url = new URL(String(value.url)); }
		catch { throw invalid("target.url debe ser una URL absoluta"); }
		if (!(HTTP_TARGET_PROTOCOLS as readonly string[]).includes(url.protocol)) throw invalid(`target.url debe usar ${HTTP_TARGET_PROTOCOLS.join(" o ")}`);
		if (url.username || url.password) throw invalid("target.url no puede llevar credenciales");
		return { type: "http", url: url.toString() };
	}
	if (typeof value.command !== "string" || !value.command.trim()) throw invalid("target.command debe ser un ejecutable");
	const args = value.args ?? [];
	if (!Array.isArray(args) || !args.every((argument) => typeof argument === "string")) throw invalid("target.args debe ser una lista de strings");
	return { type: "command", command: value.command, args: args as string[] };
}

function parseEvents(raw: ConfigRecord): SessionSignalEvent[] {
	if (raw.events === undefined) return [...SESSION_SIGNAL_EVENTS];
	const valid = Array.isArray(raw.events) && raw.events.length > 0 && raw.events.every((event) => (SESSION_SIGNAL_EVENTS as readonly unknown[]).includes(event));
	if (!valid) throw invalid(`events debe ser una lista no vacía de ${SESSION_SIGNAL_EVENTS.join(", ")}`);
	return [...new Set(raw.events as SessionSignalEvent[])];
}

function parseTimeout(raw: ConfigRecord): number {
	if (raw.timeoutMs === undefined) return SESSION_SIGNALS.DEFAULT_TIMEOUT_MS;
	if (typeof raw.timeoutMs !== "number" || !Number.isInteger(raw.timeoutMs) || raw.timeoutMs <= 0 || raw.timeoutMs > SESSION_SIGNALS.MAX_TIMEOUT_MS) throw invalid(`timeoutMs debe ser un entero entre 1 y ${SESSION_SIGNALS.MAX_TIMEOUT_MS}`);
	return raw.timeoutMs;
}

/** Reads `session-signals.json`. A missing file means "no signals"; anything malformed rejects it. */
export function loadSessionSignalsConfig(configHome: string): SessionSignalsConfig | undefined {
	const raw = readIntegrationConfig(INTEGRATION, sessionSignalsConfigPath(configHome), SESSION_SIGNALS.CONFIG_SCHEMA);
	if (!raw) return undefined;
	return {
		enabled: optionalBoolean(INTEGRATION, raw, "enabled", true),
		includeChildren: optionalBoolean(INTEGRATION, raw, "includeChildren", false),
		events: parseEvents(raw),
		target: parseTarget(raw.target),
		timeoutMs: parseTimeout(raw),
	};
}

export function signalPayload(event: SessionSignalEvent, sessionId: string, now: Date = new Date()): SessionSignalPayload {
	return { schema: SESSION_SIGNALS.PAYLOAD_SCHEMA, event, sessionId, timestamp: now.toISOString() };
}

/** Bare names are looked up on PATH; anything with a separator or `~` is a configured path. */
function resolveCommand(command: string, configHome: string, home: string, environment: NodeJS.ProcessEnv): string {
	const isBareName = !isAbsolute(command) && !/[\\/]/.test(command) && !command.startsWith("~");
	return resolveExecutable(isBareName ? command : resolveConfiguredPath(command, configHome, home), environment);
}

/** Environment a command target receives: only what locating executables needs, never the session's secrets. */
function minimalEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const kept = ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "HOME", "USERPROFILE", "TEMP", "TMP", "TMPDIR", "LANG"];
	return Object.fromEntries(kept.filter((key) => environment[key] !== undefined).map((key) => [key, environment[key]]));
}

export interface DeliveryOptions {
	configHome: string;
	cwd: string;
	signal: AbortSignal;
	home?: string;
	environment?: NodeJS.ProcessEnv;
}

/**
 * Delivers one signal, bounded by the configured timeout and cancelled with
 * the session. Throws a contextual error on any failure; callers report it and
 * carry on, because a signal never gates the session.
 */
export async function deliverSignal(config: SessionSignalsConfig, payload: SessionSignalPayload, options: DeliveryOptions): Promise<void> {
	const signal = AbortSignal.any([options.signal, AbortSignal.timeout(config.timeoutMs)]);
	const describe = config.target.type === "http" ? `POST ${config.target.url}` : config.target.command;
	try {
		if (config.target.type === "http") {
			const response = await fetch(config.target.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal, redirect: "error" });
			await response.body?.cancel();
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			return;
		}
		const environment = options.environment ?? process.env;
		const executable = resolveCommand(config.target.command, options.configHome, options.home ?? homedir(), environment);
		const result = await runProcess(executable, config.target.args, { cwd: options.cwd, environment: minimalEnvironment(environment), input: JSON.stringify(payload), timeoutMs: config.timeoutMs, outputLimitBytes: SESSION_SIGNALS.COMMAND_OUTPUT_LIMIT_BYTES, signal: options.signal });
		if (result.code !== 0) throw new Error(`terminó con código ${result.code}${result.stderr.trim() ? `: ${result.stderr.trim().slice(0, 200)}` : ""}`);
	} catch (error) {
		const cause = signal.aborted && !options.signal.aborted ? `sin respuesta en ${config.timeoutMs}ms` : errorDetail(error);
		throw new Error(`${INTEGRATION}: no se pudo enviar ${payload.event} a ${describe} (${cause})`, { cause: error });
	}
}
