/**
 * Static contracts of the optional integrations (golfo-shell#7). Each
 * integration owns its own configuration file inside the Gentle AI config
 * home; none of them is imported by the Claude Code bridge (`claude-compat`).
 */

/** Environment flag Gentle Agents sets in every child process. */
export const AGENTS_CHILD_ENV = "GENTLE_PI_AGENTS_CHILD";

/** Declarative session context: hidden text injected at session start and after compaction. */
export const SESSION_CONTEXT = {
	CONFIG_FILE: "session-context.json",
	CONFIG_SCHEMA: "gentle-pi.session-context/v1",
	/** Custom message type of the injected context. */
	MESSAGE_TYPE: "session-context",
	/** Custom entry that records `/session-context off|on` in the session. */
	STATE_ENTRY_TYPE: "session-context-state",
	COMMAND: "session-context",
	/** Largest text accepted for one entry; longer context is rejected, never truncated. */
	MAX_ENTRY_BYTES: 16 * 1024,
} as const;

/** Moments of the session cycle a context entry can be delivered on. */
export type SessionContextTrigger = "startup" | "resume" | "clear" | "fork" | "compact";
export const SESSION_CONTEXT_TRIGGERS = ["startup", "resume", "clear", "fork", "compact"] as const satisfies readonly SessionContextTrigger[];

/** Session signals sent to an optional external consumer. */
export const SESSION_SIGNALS = {
	CONFIG_FILE: "session-signals.json",
	CONFIG_SCHEMA: "gentle-pi.session-signals/v1",
	/** Schema of the payload every target receives. */
	PAYLOAD_SCHEMA: "gentle-pi.session-signal/v1",
	DEFAULT_TIMEOUT_MS: 2_000,
	MAX_TIMEOUT_MS: 10_000,
	/** Output kept from a command target; it is only read for diagnostics. */
	COMMAND_OUTPUT_LIMIT_BYTES: 16 * 1024,
} as const;

/** Signal names: a run starts (`turn_start`) and the agent goes idle (`activity_end`). */
export type SessionSignalEvent = "turn_start" | "activity_end";
export const SESSION_SIGNAL_EVENTS = ["turn_start", "activity_end"] as const satisfies readonly SessionSignalEvent[];

export type SessionSignalTargetType = "command" | "http";
export const SESSION_SIGNAL_TARGET_TYPES = ["command", "http"] as const satisfies readonly SessionSignalTargetType[];
/** URL schemes an HTTP target may use. */
export const HTTP_TARGET_PROTOCOLS = ["http:", "https:"] as const;

/** Optional guard that keeps memory writes on the native provider. */
export const MEMORY_WRITE_GUARD = {
	CONFIG_FILE: "memory-write-guard.json",
	CONFIG_SCHEMA: "gentle-pi.memory-write-guard/v1",
	COMMAND: "memory-write-guard",
} as const;
