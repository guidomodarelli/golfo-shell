import { COMMAND_WILDCARD_SUFFIXES, PI_BASH_TOOL, POLICY_TOOL_PREFIX, RESTRICTED_COMMAND_PATTERN, RESTRICTED_PATTERN_WORD } from "./constants.ts";

/** A `Bash(pattern)` grant, parsed once at import time. */
export interface CommandPattern {
	/** Literal argv prefix. */
	words: string[];
	/** Whether more arguments may follow the prefix. */
	prefix: boolean;
	/** Original declaration, for reports. */
	source: string;
}

/** Tool policy of one imported agent, enforced on every `tool_call` of its child. */
export interface AgentPolicy {
	name: string;
	marker: string;
	/** Exact Pi tool names the child may call. */
	tools: string[];
	/** MCP namespaces granted as a whole (`mcp__server` in Claude Code). */
	toolPrefixes: string[];
	unrestrictedBash: boolean;
	commandPatterns: CommandPattern[];
	unsupported: string[];
	source: string;
}

/** Thrown for any call the policy cannot authorize; the guard turns it into a block. */
export class PolicyViolation extends Error {}

/**
 * Parses the inside of `Bash(...)`. Only an argv prefix with an optional
 * trailing wildcard is representable; anything else returns undefined.
 */
export function parseCommandPattern(source: string): CommandPattern | undefined {
	let body = source.trim();
	let prefix = false;
	for (const suffix of COMMAND_WILDCARD_SUFFIXES) {
		if (body.endsWith(suffix)) { body = body.slice(0, -suffix.length).trim(); prefix = true; break; }
	}
	const words = body.split(/\s+/).filter(Boolean);
	if (words.length === 0 || !words.every((word) => RESTRICTED_PATTERN_WORD.test(word))) return undefined;
	return { words, prefix, source };
}

/**
 * Validates a restricted command: one argv in the conservative grammar that
 * matches a declared pattern. Shell syntax is blocked, never interpreted.
 */
export function assertRestrictedCommand(command: unknown, patterns: readonly CommandPattern[]): string[] {
	if (typeof command !== "string" || !RESTRICTED_COMMAND_PATTERN.test(command.trim())) {
		throw new PolicyViolation("orden restringida rechazada: usar un argv simple, sin comillas, operadores, redirecciones ni expansiones de shell");
	}
	const words = command.trim().split(" ");
	const allowed = patterns.some((pattern) => pattern.words.every((word, index) => words[index] === word) &&
		(pattern.prefix ? words.length >= pattern.words.length : words.length === pattern.words.length));
	if (!allowed) throw new PolicyViolation(`comando fuera de la allowlist del agente (${patterns.map((pattern) => `Bash(${pattern.source})`).join(", ")})`);
	return words;
}

/**
 * The policy bound to this child, from the marker tool in its exact `--tools`
 * list. No marker: not an imported agent. Unknown or several markers: refused.
 */
export function resolveChildPolicy(environment: NodeJS.ProcessEnv, requestedToolsVariable: string, policies: readonly AgentPolicy[] | undefined): AgentPolicy | null {
	if (environment.GENTLE_PI_AGENTS_CHILD !== "1") return null;
	const markers = (environment[requestedToolsVariable] ?? "").split(",").map((name) => name.trim()).filter((name) => name.startsWith(POLICY_TOOL_PREFIX));
	if (markers.length === 0) return null;
	if (markers.length !== 1) throw new PolicyViolation("varias políticas de agente importado en un mismo child; ejecución rechazada");
	const policy = policies?.find((candidate) => candidate.marker === markers[0]);
	if (!policy) throw new PolicyViolation(`política de agente importado desconocida (${markers[0]}); ejecutar /claude-compat:sync`);
	return policy;
}

/** Whether the bound policy admits a tool name (exact or granted MCP namespace). */
export function agentToolAllowed(policy: AgentPolicy, toolName: string): boolean {
	return policy.tools.includes(toolName) || policy.toolPrefixes.some((prefix) => toolName.startsWith(`${prefix}__`));
}

/**
 * Full decision for one tool call of a bound child. Returns undefined when the
 * call may proceed to the host's own checks; throws PolicyViolation otherwise.
 */
export function enforceAgentPolicy(policy: AgentPolicy, toolName: string, input: Record<string, unknown>): void {
	if (!agentToolAllowed(policy, toolName)) throw new PolicyViolation(`herramienta ${toolName} fuera de la allowlist del agente ${policy.name} (incluye llamadas anidadas, MCP y delegación)`);
	if (toolName !== PI_BASH_TOOL || policy.unrestrictedBash) return;
	if (policy.commandPatterns.length === 0) throw new PolicyViolation(`el agente ${policy.name} no tiene patrones Bash representables`);
	assertRestrictedCommand(input.command, policy.commandPatterns);
}
