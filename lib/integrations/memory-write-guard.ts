import { join } from "node:path";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { MCP_TOOL_PREFIX, piMcpToolName } from "../mcp-tool-name.ts";
import { IntegrationConfigError, isRecord, optionalBoolean, readIntegrationConfig } from "./config-file.ts";
import { MEMORY_WRITE_GUARD } from "./constants.ts";

const INTEGRATION = "memory-write-guard";
/** Tool name grammar accepted in the configuration (Pi and MCP names). */
const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]*$/;

/** The native memory route that must work before other writes are refused. */
export interface NativeAlternative {
	/** Tools of the native provider; every one must be loaded exactly once. */
	tools: string[];
	/** Package source the native tools must come from (`npm:<name>`, any version), when set. */
	source?: string;
}

export interface MemoryWriteGuardConfig {
	enabled: boolean;
	/** Write operations of other memory providers, as Pi or Claude Code MCP names. */
	protectedTools: string[];
	nativeAlternative: NativeAlternative;
}

/**
 * Activation outcome: `active` blocks the protected writes; `rejected` means
 * the guard was asked for but its native alternative is not available, so it
 * is not declared active and nothing is blocked; `inactive` means not configured.
 */
export type GuardActivation =
	| { status: "inactive" }
	| { status: "rejected"; reason: string }
	| { status: "active"; config: MemoryWriteGuardConfig };

export function memoryWriteGuardConfigPath(configHome: string): string {
	return join(configHome, MEMORY_WRITE_GUARD.CONFIG_FILE);
}

function invalid(detail: string): IntegrationConfigError {
	return new IntegrationConfigError(`${INTEGRATION}: ${detail}`);
}

function toolList(value: unknown, field: string): string[] {
	if (!Array.isArray(value) || value.length === 0 || !value.every((name) => typeof name === "string" && TOOL_NAME_PATTERN.test(name))) throw invalid(`${field} debe ser una lista no vacía de nombres de herramientas`);
	return [...new Set(value as string[])];
}

/** Pi name of a configured tool: Claude Code MCP names are normalized as Pi does. */
export function piToolName(name: string): string {
	return name.startsWith(MCP_TOOL_PREFIX) ? piMcpToolName(name) : name;
}

/** Reads `memory-write-guard.json`. A missing file means "not configured"; anything malformed rejects it. */
export function loadMemoryWriteGuardConfig(configHome: string): MemoryWriteGuardConfig | undefined {
	const raw = readIntegrationConfig(INTEGRATION, memoryWriteGuardConfigPath(configHome), MEMORY_WRITE_GUARD.CONFIG_SCHEMA);
	if (!raw) return undefined;
	const enabled = optionalBoolean(INTEGRATION, raw, "enabled", true);
	const protectedTools = toolList(raw.protectedTools, "protectedTools");
	if (!isRecord(raw.nativeAlternative)) throw invalid("nativeAlternative debe ser un objeto con tools");
	const nativeTools = toolList(raw.nativeAlternative.tools, "nativeAlternative.tools");
	const source = raw.nativeAlternative.source;
	if (source !== undefined && (typeof source !== "string" || !source.trim())) throw invalid("nativeAlternative.source debe ser un string no vacío");
	const overlap = nativeTools.filter((tool) => protectedTools.some((protectedTool) => piToolName(protectedTool) === piToolName(tool)));
	if (overlap.length > 0) throw invalid(`una herramienta no puede ser a la vez protegida y alternativa nativa (${overlap.join(", ")})`);
	return { enabled, protectedTools, nativeAlternative: { tools: nativeTools, ...(typeof source === "string" ? { source } : {}) } };
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Why the native alternative cannot take the writes, or undefined when every
 * native tool is loaded exactly once (from `source`, when configured).
 */
export function missingNativeAlternative(alternative: NativeAlternative, tools: readonly ToolInfo[]): string | undefined {
	const sourcePattern = alternative.source ? new RegExp(`^${escapeRegExp(alternative.source)}(?:@[^\\s/]+)?$`) : undefined;
	for (const name of alternative.tools) {
		const matches = tools.filter((tool) => tool.name === name);
		if (matches.length === 0) return `la herramienta nativa ${name} no está cargada`;
		if (matches.length > 1) return `la herramienta nativa ${name} está registrada ${matches.length} veces`;
		if (sourcePattern && !sourcePattern.test(matches[0].sourceInfo?.source ?? "")) return `la herramienta nativa ${name} no proviene de ${alternative.source}`;
	}
	return undefined;
}

/** Decides activation from the configuration and the tools Pi loaded. */
export function activateMemoryWriteGuard(config: MemoryWriteGuardConfig | undefined, tools: readonly ToolInfo[]): GuardActivation {
	if (!config || !config.enabled) return { status: "inactive" };
	const missing = missingNativeAlternative(config.nativeAlternative, tools);
	if (missing) return { status: "rejected", reason: `${missing}; sin una ruta nativa para escribir memoria la protección no se activa` };
	return { status: "active", config };
}

/** Whether a Pi tool call is one of the protected writes (exact name, MCP names normalized). */
export function isProtectedWrite(config: MemoryWriteGuardConfig, toolName: string): boolean {
	return config.protectedTools.some((name) => piToolName(name) === toolName);
}
