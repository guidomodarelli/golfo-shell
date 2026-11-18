import type { HookClassification } from "./hooks.ts";
import type { ClaudeCompatState } from "./sync.ts";

const HOOK_SECTION_TITLES: Readonly<Record<HookClassification, string>> = {
	adapted: "Hooks adaptados (revisados)",
	"native-equivalent": "Equivalentes nativos (no se importan)",
	pending: "Capacidades pendientes (no se ejecutan)",
};
const HOOK_SECTION_ORDER: readonly HookClassification[] = ["adapted", "native-equivalent", "pending"];

function section(title: string, lines: readonly string[]): string[] {
	return lines.length === 0 ? [] : ["", `${title}:`, ...lines.map((line) => `  - ${line}`)];
}

/** Plain-text summary of an import, shown by the sync and status commands. */
export function formatClaudeCompatReport(state: ClaudeCompatState): string {
	const adaptedSkills = state.skills.filter((skill) => skill.adapted);
	const unavailableGuards = state.hooks.filter((hook) => hook.unavailable !== undefined);
	const unsupported = state.policies.filter((policy) => policy.unsupported.length > 0);
	const lines = [
		`claude-compat: ${state.plugins.length} plugins, ${state.skills.length} skills (${adaptedSkills.length} adaptadas), ${state.agents.length} agentes, ${state.hooks.length - unavailableGuards.length} hooks revisados.`,
		...section("Skills renombradas/adaptadas en caché derivada", adaptedSkills.map((skill) => `${skill.sourceName} → ${skill.name}`)),
		...section("Skills duplicadas (se conservó la primera)", state.duplicates.map((duplicate) => `${duplicate.name}: excluida ${duplicate.excluded} (gana ${duplicate.selected})`)),
		...section("Skills desactivadas por skillOverrides (\"off\")", (state.disabledSkills ?? []).map((skill) => `${skill.override}: ${skill.file}`)),
		...section("Skills omitidas", state.skippedSkills.map((skill) => `${skill.file}: ${skill.reason}`)),
		...section("Plugins no importados", state.skippedPlugins.map((plugin) => `${plugin.key}: ${plugin.reason}`)),
		...section("Herramientas sin equivalente (no se conceden)", unsupported.map((policy) => `${policy.name}: ${policy.unsupported.join(", ")}`)),
		...section("Campos de agente no importados", state.agents.filter((agent) => agent.omitted.length > 0).map((agent) => `${agent.name}: ${agent.omitted.join("; ")}`)),
		...section("Agentes que requieren adaptación manual", state.agentErrors.map((error) => `${error.source}: ${error.reason}`)),
		...section("Hooks revisados no disponibles", state.hookErrors),
		...section("Guards no disponibles (bloquean las llamadas que cubren)", unavailableGuards.map((hook) => `${hook.id}: ${hook.tools?.join(", ") ?? "todas las herramientas"}`)),
		...HOOK_SECTION_ORDER.flatMap((classification) => section(HOOK_SECTION_TITLES[classification], state.hookInventory
			.filter((entry) => entry.classification === classification)
			.map((entry) => `${entry.origin} ${entry.event}${entry.command ? ` (${entry.command})` : ""}: ${entry.reason}`))),
		...section("Archivos derivados conservados por estar modificados", state.retainedModified),
	];
	return lines.join("\n");
}
