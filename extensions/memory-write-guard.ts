import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { gentlePiConfigHome } from "../lib/agent-home.ts";
import { errorDetail } from "../lib/integrations/config-file.ts";
import { MEMORY_WRITE_GUARD } from "../lib/integrations/constants.ts";
import { activateMemoryWriteGuard, type GuardActivation, isProtectedWrite, loadMemoryWriteGuardConfig, memoryWriteGuardConfigPath, missingNativeAlternative } from "../lib/integrations/memory-write-guard.ts";

export interface MemoryWriteGuardDependencies {
	env?: NodeJS.ProcessEnv;
	configHome?: string;
}

/**
 * Optional memory write guard (golfo-shell#7): while active, the configured
 * writes of other memory providers are refused so memory is written through
 * the native provider. It activates only when that native route is loaded; once
 * active, losing it blocks the protected writes instead of silently reopening
 * them. Reads and every other tool are never touched.
 */
export function createMemoryWriteGuardExtension(dependencies: MemoryWriteGuardDependencies = {}): (pi: ExtensionAPI) => void {
	return (pi) => {
		const env = dependencies.env ?? process.env;
		const configHome = dependencies.configHome ?? gentlePiConfigHome(env);
		let activation: GuardActivation = { status: "inactive" };
		let configError: string | undefined;

		pi.on("session_start", (_event, ctx) => {
			configError = undefined;
			try {
				activation = activateMemoryWriteGuard(loadMemoryWriteGuardConfig(configHome), pi.getAllTools());
			} catch (error) {
				activation = { status: "inactive" };
				configError = errorDetail(error);
			}
			if (configError) ctx.ui.notify(`${configError}. La protección de escrituras de memoria no está activa; corregir ${memoryWriteGuardConfigPath(configHome)}.`, "error");
			else if (activation.status === "rejected") ctx.ui.notify(`memory-write-guard: activación rechazada: ${activation.reason}.`, "error");
		});

		pi.on("tool_call", (event) => {
			if (activation.status !== "active" || !isProtectedWrite(activation.config, event.toolName)) return undefined;
			const native = activation.config.nativeAlternative.tools.join(", ");
			const missing = missingNativeAlternative(activation.config.nativeAlternative, pi.getAllTools());
			if (missing) return { block: true, reason: `memory-write-guard: ${event.toolName} está protegida y su alternativa nativa dejó de estar disponible (${missing}); no se ejecutó la escritura. Restaurar el proveedor nativo o desactivar la protección en ${memoryWriteGuardConfigPath(configHome)} y recargar.` };
			return { block: true, reason: `memory-write-guard: ${event.toolName} está protegida; escribir la memoria con la herramienta nativa (${native}).` };
		});

		pi.registerCommand(MEMORY_WRITE_GUARD.COMMAND, {
			description: "Mostrar si la protección de escrituras de memoria está activa, rechazada o sin configurar.",
			async handler(_args, ctx) {
				if (configError) { ctx.ui.notify(`memory-write-guard: configuración inválida: ${configError}`, "error"); return; }
				if (activation.status === "inactive") { ctx.ui.notify(`memory-write-guard: inactiva (sin ${memoryWriteGuardConfigPath(configHome)} o enabled: false)`, "info"); return; }
				if (activation.status === "rejected") { ctx.ui.notify(`memory-write-guard: rechazada: ${activation.reason}`, "error"); return; }
				ctx.ui.notify(`memory-write-guard: activa. Protege ${activation.config.protectedTools.join(", ")}; alternativa nativa: ${activation.config.nativeAlternative.tools.join(", ")}`, "info");
			},
		});
	};
}

export default function memoryWriteGuardExtension(pi: ExtensionAPI): void {
	createMemoryWriteGuardExtension()(pi);
}
