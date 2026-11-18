/**
 * Static contract of the Claude Code compatibility importer (golfo-shell#4).
 * Everything here is an invariant of the adapter, not user configuration: the
 * reviewed hook allowlist and native equivalents live in `claude-compat.json`
 * (see `lib/claude-compat/config.ts`).
 */

/** Schema of the derived state file; a different value is never read. */
export const CLAUDE_COMPAT_STATE_SCHEMA = "gentle-pi.claude-compat-state/v1";
/** Schema of the user configuration file. */
export const CLAUDE_COMPAT_CONFIG_SCHEMA = "gentle-pi.claude-compat/v1";
/** File name of the user configuration inside the Gentle AI config home. */
export const CLAUDE_COMPAT_CONFIG_FILE = "claude-compat.json";
/** Directory (inside the Pi agent home) that holds derived, regenerable artifacts. */
export const CLAUDE_COMPAT_IMPORT_DIRECTORY = "claude-import";
/** Derived state file inside the import directory. */
export const CLAUDE_COMPAT_STATE_FILE = "state.json";
/** Derived skill cache inside the import directory. */
export const CLAUDE_COMPAT_SKILLS_DIRECTORY = "skills";

/** Prefix of every agent the importer writes into `<agentHome>/agents`. */
export const MANAGED_AGENT_PREFIX = "claude-";
/** Prefix of the hidden marker tool that binds a child to its imported policy. */
export const POLICY_TOOL_PREFIX = "claude_policy_";
/** Tool every Gentle Agents child receives from the runner. */
export const PARENT_NOTIFICATION_TOOL = "subagent_parent_message";

/** Agent Skills portable name: lowercase words joined by single hyphens. */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Longest portable skill name allowed by the Agent Skills format. */
export const SKILL_NAME_MAX_LENGTH = 64;
/** Companion directories copied next to an adapted SKILL.md so relative links keep working. */
export const SKILL_RESOURCE_DIRECTORIES = ["references", "scripts", "assets"] as const;
/** Skill entry file name. */
export const SKILL_FILE_NAME = "SKILL.md";

/** Bounded directory walk: deeper trees are ignored, never followed. */
export const MAX_SCAN_DEPTH = 12;

/** Claude Code tool → Pi tool. Anything absent is reported and never granted. */
export const CLAUDE_TOOL_EQUIVALENTS: Readonly<Record<string, string>> = {
	Bash: "bash",
	Read: "read",
	Write: "write",
	Edit: "edit",
	MultiEdit: "edit",
	Grep: "grep",
	Glob: "find",
	LS: "ls",
	Skill: "read",
	ToolSearch: "tool_search",
	AskUserQuestion: "ask_user_question",
};

/** Claude Code tool name that grants shell access. */
export const CLAUDE_BASH_TOOL = "Bash";
/** Pi shell tool the importer maps `Bash` and `Bash(pattern)` to. */
export const PI_BASH_TOOL = "bash";
/** Prefix of Claude Code and Pi MCP tool names (`mcp__<server>__<tool>`). */
export const MCP_TOOL_PREFIX = "mcp__";
/** Separator between the MCP server and tool segments. */
export const MCP_SEGMENT_SEPARATOR = "__";

/**
 * Conservative grammar for `Bash(pattern)` commands: one argv, no quoting,
 * expansion, redirection, globbing or operators. Anything else is blocked.
 */
export const RESTRICTED_COMMAND_PATTERN = /^[A-Za-z0-9_./:@%+=,-]+(?: [A-Za-z0-9_./:@%+=,-]+)*$/;
/** Same grammar for the literal part of a `Bash(pattern)` declaration. */
export const RESTRICTED_PATTERN_WORD = /^[A-Za-z0-9_./:@%+=,-]+$/;
/** Trailing wildcard forms Claude Code accepts: `Bash(git diff *)` and legacy `Bash(git diff:*)`. */
export const COMMAND_WILDCARD_SUFFIXES = [" *", ":*"] as const;

/** Claude permission modes that must never be imported. */
export const FORBIDDEN_PERMISSION_MODES = ["bypassPermissions", "acceptEdits", "dontAsk", "auto"] as const;
/** Claude agent model value meaning "use the parent's model". */
export const INHERIT_MODEL = "inherit";

/** Hook events the adapter knows how to translate. */
export const HOOK_EVENT = {
	SESSION_START: "SessionStart",
	PRE_TOOL_USE: "PreToolUse",
	POST_TOOL_USE: "PostToolUse",
} as const;
export type SupportedHookEvent = "SessionStart" | "PreToolUse" | "PostToolUse";
export const SUPPORTED_HOOK_EVENTS = Object.values(HOOK_EVENT) satisfies readonly SupportedHookEvent[];

/** Pi tool → Claude Code tool name inside translated hook payloads. */
export const PI_TO_CLAUDE_TOOL: Readonly<Record<string, string>> = {
	bash: "Bash",
	read: "Read",
	write: "Write",
	edit: "Edit",
	grep: "Grep",
	find: "Glob",
	ls: "LS",
};

/** Hook process bounds: every reviewed hook fails closed past these limits. */
export const HOOK_TIMEOUT_MS = 10_000;
export const HOOK_OUTPUT_LIMIT_BYTES = 512 * 1024;
/** Script extensions executed with the running Node.js; everything else runs with bash. */
export const NODE_SCRIPT_EXTENSIONS = [".js", ".mjs", ".cjs"] as const;

/**
 * Plugins whose behavior Gentle Shell already provides natively. Importing them
 * would duplicate memory writes or effects, so they are reported instead.
 */
export const DEFAULT_NATIVE_EQUIVALENTS: Readonly<Record<string, string>> = {
	engram: "Gentle AI integra Engram (gentle-engram) como memoria nativa",
};

/** Custom message type for context returned by reviewed hooks. */
export const HOOK_CONTEXT_MESSAGE_TYPE = "claude-compat-context";
/** Slash commands registered by the extension. */
export const SYNC_COMMAND = "claude-compat:sync";
export const STATUS_COMMAND = "claude-compat:status";
