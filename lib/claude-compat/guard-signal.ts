import { POLICY_TOOL_PREFIX } from "./constants.ts";

// Process-wide flag shared by separately loaded extension modules: the
// claude-compat guard sets it while registering, and child-safety (part of the
// frozen child fallback) blocks imported-agent children when it is absent.
const GUARD_ACTIVE = Symbol.for("gentle-pi.claude-compat.guard-active");

type GuardRegistry = { [GUARD_ACTIVE]?: boolean };

export function markClaudeCompatGuardActive(): void {
	(globalThis as GuardRegistry)[GUARD_ACTIVE] = true;
}

export function claudeCompatGuardActive(): boolean {
	return (globalThis as GuardRegistry)[GUARD_ACTIVE] === true;
}

/** Whether this process is a child launched for an imported Claude Code agent. */
export function requestsImportedPolicy(environment: NodeJS.ProcessEnv, requestedToolsVariable: string): boolean {
	return environment.GENTLE_PI_AGENTS_CHILD === "1" &&
		(environment[requestedToolsVariable] ?? "").split(",").some((name) => name.trim().startsWith(POLICY_TOOL_PREFIX));
}
