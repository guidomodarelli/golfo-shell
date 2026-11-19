/** Prefix of Claude Code and Pi MCP tool names (`mcp__<server>__<tool>`). */
export const MCP_TOOL_PREFIX = "mcp__";
/** Separator between the MCP server and tool segments. */
export const MCP_SEGMENT_SEPARATOR = "__";

/** Pi normalizes MCP server names to `[A-Za-z0-9_]` (`dev-docs` → `dev_docs`). */
export function piMcpToolName(claudeName: string): string {
	const [server, ...rest] = claudeName.slice(MCP_TOOL_PREFIX.length).split(MCP_SEGMENT_SEPARATOR);
	return [`${MCP_TOOL_PREFIX}${server.replace(/[^A-Za-z0-9_]/g, "_")}`, ...rest].join(MCP_SEGMENT_SEPARATOR);
}
