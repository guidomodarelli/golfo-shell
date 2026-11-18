import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { THINKING_LEVELS } from "../model-routing-authority.ts";
import { type AgentPolicy, type CommandPattern, parseCommandPattern } from "./agent-policy.ts";
import { CLAUDE_BASH_TOOL, CLAUDE_TOOL_EQUIVALENTS, FORBIDDEN_PERMISSION_MODES, INHERIT_MODEL, MANAGED_AGENT_PREFIX, MCP_SEGMENT_SEPARATOR, MCP_TOOL_PREFIX, PARENT_NOTIFICATION_TOOL, PI_BASH_TOOL, POLICY_TOOL_PREFIX } from "./constants.ts";
import { findMarkdownFiles, isInside, type ManagedFiles, readFrontmatter, writeManagedFile } from "./files.ts";
import { claudeDirectory, type ClaudePlugin, manifestPaths } from "./plugins.ts";

/** Origin label of agents read from `~/.claude/agents`. */
export const USER_AGENT_OWNER = "user";

export interface ConvertedAgent {
	name: string;
	file: string;
	source: string;
	model?: string;
	thinking?: string;
	omitted: string[];
}

export interface AgentImportError {
	source: string;
	reason: string;
}

export interface AgentCatalog {
	agents: ConvertedAgent[];
	policies: AgentPolicy[];
	errors: AgentImportError[];
}

interface AgentSource {
	file: string;
	owner: string;
	root: string;
}

function identifierOf(value: string): string {
	return value.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Pi normalizes MCP server names to `[A-Za-z0-9_]` (`dev-docs` → `dev_docs`). */
export function piMcpToolName(claudeName: string): string {
	const [server, ...rest] = claudeName.slice(MCP_TOOL_PREFIX.length).split(MCP_SEGMENT_SEPARATOR);
	return [`${MCP_TOOL_PREFIX}${server.replace(/[^A-Za-z0-9_]/g, "_")}`, ...rest].join(MCP_SEGMENT_SEPARATOR);
}

/** Splits a `tools:` value, keeping commas inside `Bash(...)` together. */
export function splitToolList(value: string): string[] {
	const tools: string[] = [];
	let depth = 0;
	let current = "";
	for (const character of value.replace(/^\[|\]$/g, "")) {
		if (character === "(") depth++;
		if (character === ")") depth = Math.max(0, depth - 1);
		if (character === "," && depth === 0) { tools.push(current); current = ""; continue; }
		current += character;
	}
	tools.push(current);
	return tools.map((tool) => tool.trim().replace(/^(['"])(.*)\1$/, "$2")).filter(Boolean);
}

/**
 * Translates declared Claude Code tools into an exact Pi allowlist. Tools
 * without a safe equivalent are reported, never replaced by stronger ones.
 */
export function translateTools(declared: readonly string[]): Pick<AgentPolicy, "tools" | "toolPrefixes" | "unrestrictedBash" | "commandPatterns" | "unsupported"> {
	const tools = new Set<string>();
	const toolPrefixes = new Set<string>();
	const commandPatterns: CommandPattern[] = [];
	const unsupported: string[] = [];
	let unrestrictedBash = false;
	for (const tool of declared) {
		const restricted = /^Bash\((.*)\)$/s.exec(tool);
		if (restricted) {
			const pattern = parseCommandPattern(restricted[1]);
			if (pattern) { commandPatterns.push(pattern); tools.add(PI_BASH_TOOL); } else unsupported.push(tool);
			continue;
		}
		if (tool === CLAUDE_BASH_TOOL) { unrestrictedBash = true; tools.add(PI_BASH_TOOL); continue; }
		if (/^Skill\(.+\)$/.test(tool)) { tools.add(CLAUDE_TOOL_EQUIVALENTS.Skill); continue; }
		if (CLAUDE_TOOL_EQUIVALENTS[tool]) { tools.add(CLAUDE_TOOL_EQUIVALENTS[tool]); continue; }
		if (tool.startsWith(MCP_TOOL_PREFIX) && !/[()*\s]/.test(tool)) {
			const name = piMcpToolName(tool);
			if (name.split(MCP_SEGMENT_SEPARATOR).length === 2) toolPrefixes.add(name);
			else tools.add(name);
			continue;
		}
		unsupported.push(tool);
	}
	return { tools: [...tools], toolPrefixes: [...toolPrefixes], unrestrictedBash, commandPatterns: unrestrictedBash ? [] : commandPatterns, unsupported };
}

function compatibilityNotice(owner: string, sourceName: string, root: string, policy: AgentPolicy, omitted: readonly string[]): string {
	return [
		"## Contrato de compatibilidad Pi (claude-compat)",
		`Origen: ${owner}:${sourceName}. Directorio de recursos: ${root.replaceAll("\\", "/")}.`,
		"Las herramientas permitidas se validan en cada tool_call, incluidas llamadas anidadas, MCP y delegación. No hay bypassPermissions ni aprobación implícita.",
		"Read/Write/Edit/Grep/Glob/LS corresponden a read/write/edit/grep/find/ls. Skill carga SKILL.md con read; ToolSearch corresponde a tool_search.",
		...(policy.commandPatterns.length > 0 ? [`Bash está restringido a: ${policy.commandPatterns.map((pattern) => `Bash(${pattern.source})`).join("; ")}. Sin comillas, operadores, redirecciones ni expansiones: dividir operaciones o informar la limitación al parent.`] : []),
		...(policy.unsupported.length > 0 ? [`Capacidades sin equivalente seguro (NO disponibles): ${policy.unsupported.join(", ")}. Si son imprescindibles, devolver el bloqueo al parent; nunca rodear la restricción con otra herramienta.`] : []),
		...(omitted.length > 0 ? [`Campos de Claude Code no importados: ${omitted.join(", ")}.`] : []),
		"Si el modelo declarado no tiene proveedor o autenticación compatible, fallar y reportarlo; no cambiar a otro modelo.",
	].join("\n");
}

/** Converts one Claude Code agent into a Pi agent file plus its enforced policy. */
export function convertAgent(source: AgentSource, agentHome: string, previous: ManagedFiles, written: ManagedFiles, reservedNames: ReadonlySet<string> = new Set()): { agent: ConvertedAgent; policy: AgentPolicy } {
	const { fields, body } = readFrontmatter(readFileSync(source.file, "utf8"));
	const sourceName = fields.name?.trim() || basename(source.file, ".md");
	const identifier = identifierOf(`${source.owner.split("@")[0]}-${sourceName}`);
	const name = `${MANAGED_AGENT_PREFIX}${identifier}`;
	if (reservedNames.has(name)) throw new Error(`nombre duplicado ${name}; se conserva la primera versión (plugin más nuevo)`);
	if (!body.trim()) throw new Error("agente sin instrucciones después del frontmatter");
	if (!fields.tools?.trim()) throw new Error("agente sin allowlist explícita de tools (en Claude Code hereda todas); requiere adaptación manual");
	const translated = translateTools(splitToolList(fields.tools));
	const marker = `${POLICY_TOOL_PREFIX}${identifier.replaceAll("-", "_").toLowerCase()}`;
	const policy: AgentPolicy = { name, marker, ...translated, tools: [...translated.tools, marker, PARENT_NOTIFICATION_TOOL], source: source.file };
	const omitted: string[] = [];
	const permissionMode = fields.permissionMode?.trim();
	if (permissionMode) omitted.push(`permissionMode: ${permissionMode}${(FORBIDDEN_PERMISSION_MODES as readonly string[]).includes(permissionMode) ? " (omite permisos; nunca se importa)" : ""}`);
	const model = fields.model?.trim() && fields.model.trim() !== INHERIT_MODEL ? fields.model.trim() : undefined;
	const effort = (fields.effort ?? fields.thinking)?.trim().toLowerCase();
	const thinking = effort && (THINKING_LEVELS as readonly string[]).includes(effort) ? effort : undefined;
	if (effort && !thinking) omitted.push(`effort: ${effort}`);
	const description = fields.description?.trim() || `Adaptación de ${source.owner}:${sourceName}`;
	const content = [
		"---",
		`name: ${name}`,
		`description: ${JSON.stringify(description)}`,
		...(model ? [`model: ${model}`] : []),
		...(thinking ? [`thinking: ${thinking}`] : []),
		`tools: ${[...translated.tools, ...translated.toolPrefixes, marker].join(", ")}`,
		"---",
		"",
		compatibilityNotice(source.owner, sourceName, source.root, policy, omitted),
		"",
		body.replaceAll("${CLAUDE_PLUGIN_ROOT}", source.root.replaceAll("\\", "/")).trim(),
		"",
	].join("\n");
	const file = join(agentHome, "agents", `${name}.md`);
	writeManagedFile(file, content, previous, written);
	return { agent: { name, file, source: source.file, ...(model ? { model } : {}), ...(thinking ? { thinking } : {}), omitted }, policy };
}

function agentSources(home: string, plugins: readonly ClaudePlugin[]): AgentSource[] {
	const sources: AgentSource[] = [];
	for (const plugin of plugins) {
		const roots = [join(plugin.root, "agents"), ...manifestPaths(plugin.manifest.agents).map((path) => resolve(plugin.root, path)).filter((path) => isInside(plugin.root, path))];
		for (const root of new Set(roots)) sources.push(...findMarkdownFiles(root).map((file) => ({ file, owner: plugin.key, root: plugin.root })));
	}
	const userRoot = join(claudeDirectory(home), "agents");
	sources.push(...findMarkdownFiles(userRoot).map((file) => ({ file, owner: USER_AGENT_OWNER, root: dirname(file) })));
	return sources;
}

/**
 * Converts every agent of the enabled plugins and `~/.claude/agents`. One
 * invalid agent is reported without blocking the rest; names stay unique.
 */
export function buildAgentCatalog(options: { home: string; agentHome: string; plugins: readonly ClaudePlugin[]; previous: ManagedFiles; written: ManagedFiles }): AgentCatalog {
	const agents: ConvertedAgent[] = [];
	const policies: AgentPolicy[] = [];
	const errors: AgentImportError[] = [];
	const names = new Set<string>();
	for (const source of agentSources(options.home, options.plugins)) {
		try {
			const converted = convertAgent(source, options.agentHome, options.previous, options.written, names);
			names.add(converted.agent.name);
			agents.push(converted.agent);
			policies.push(converted.policy);
		} catch (error) {
			errors.push({ source: source.file, reason: error instanceof Error ? error.message : String(error) });
		}
	}
	return { agents, policies, errors };
}
