import { realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { COMMAND_WILDCARD_SUFFIXES, PI_BASH_TOOL, PLUGIN_SCRIPT_WORD_PATTERN, POLICY_TOOL_PREFIX, RESTRICTED_COMMAND_PATTERN, RESTRICTED_PATTERN_WORD } from "./constants.ts";
import { isInside } from "./files.ts";

/** A word of a `Bash(pattern)` that names a script inside the plugin root. */
export interface PluginScriptWord {
	/** Position of the word in {@link CommandPattern.words}. */
	index: number;
	/** Plugin root the script must stay inside, checked again on every call. */
	root: string;
}

/** A `Bash(pattern)` grant, parsed once at import time. */
export interface CommandPattern {
	/** Literal argv prefix. */
	words: string[];
	/** Whether more arguments may follow the prefix. */
	prefix: boolean;
	/** Original declaration, for reports. */
	source: string;
	/** Words that are plugin scripts (`${CLAUDE_PLUGIN_ROOT}/…`), resolved to absolute paths. */
	scripts?: PluginScriptWord[];
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

/** Forward-slash form of a path, the one the adapted agent instructions use. */
function portablePath(path: string): string {
	return path.replaceAll("\\", "/");
}

/**
 * Whether `script` is a regular file whose real path (symlinks followed) is
 * inside the real path of `root`. Any error counts as "outside".
 */
export function scriptInsideRoot(root: string, script: string): boolean {
	try {
		return isInside(realpathSync(root), realpathSync(script)) && statSync(script).isFile();
	} catch {
		return false;
	}
}

/**
 * Resolves a `${CLAUDE_PLUGIN_ROOT}/…` word to the script's absolute path, or
 * undefined when it escapes the plugin root (`..`, symlinks), does not exist or
 * cannot be written as one argv word of the restricted grammar.
 */
function resolvePluginScriptWord(word: string, pluginRoot: string): string | undefined {
	const match = PLUGIN_SCRIPT_WORD_PATTERN.exec(word);
	if (!match) return undefined;
	const relativePath = match[1];
	if (relativePath.split(/[\\/]/).includes("..")) return undefined;
	const script = portablePath(join(pluginRoot, relativePath));
	if (!RESTRICTED_PATTERN_WORD.test(script) || !scriptInsideRoot(pluginRoot, script)) return undefined;
	return script;
}

/**
 * Parses the inside of `Bash(...)`. Only an argv prefix with an optional
 * trailing wildcard is representable; anything else returns undefined. With
 * `pluginRoot` (agents of a plugin), a `${CLAUDE_PLUGIN_ROOT}/…` word becomes
 * the absolute path of that script, which must exist inside the root.
 */
export function parseCommandPattern(source: string, pluginRoot?: string): CommandPattern | undefined {
	let body = source.trim();
	let prefix = false;
	for (const suffix of COMMAND_WILDCARD_SUFFIXES) {
		if (body.endsWith(suffix)) { body = body.slice(0, -suffix.length).trim(); prefix = true; break; }
	}
	const words = body.split(/\s+/).filter(Boolean);
	const scripts: PluginScriptWord[] = [];
	for (const [index, word] of words.entries()) {
		if (!pluginRoot || !PLUGIN_SCRIPT_WORD_PATTERN.test(word)) continue;
		const script = resolvePluginScriptWord(word, pluginRoot);
		if (!script) return undefined;
		words[index] = script;
		scripts.push({ index, root: portablePath(pluginRoot) });
	}
	if (words.length === 0 || !words.every((word) => RESTRICTED_PATTERN_WORD.test(word))) return undefined;
	return { words, prefix, source, ...(scripts.length > 0 ? { scripts } : {}) };
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
	const matching = patterns.filter((pattern) => pattern.words.every((word, index) => words[index] === word) &&
		(pattern.prefix ? words.length >= pattern.words.length : words.length === pattern.words.length));
	if (matching.length === 0) throw new PolicyViolation(`comando fuera de la allowlist del agente (${patterns.map((pattern) => `Bash(${pattern.source})`).join(", ")})`);
	// A plugin script is checked again on each call: replacing it after the import
	// with a symlink that points outside its plugin must not widen the grant.
	const contained = matching.some((pattern) => (pattern.scripts ?? []).every((script) => scriptInsideRoot(script.root, words[script.index])));
	if (!contained) throw new PolicyViolation(`script fuera de la raíz autorizada de su plugin o inexistente (${matching.map((pattern) => `Bash(${pattern.source})`).join(", ")}); restaurarlo y ejecutar /claude-compat:sync`);
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
	const matching = policies?.filter((candidate) => candidate.marker === markers[0]) ?? [];
	if (matching.length > 1) throw new PolicyViolation(`marker de política ${markers[0]} compartido por varios agentes importados; ejecución rechazada, ejecutar /claude-compat:sync`);
	const [policy] = matching;
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
