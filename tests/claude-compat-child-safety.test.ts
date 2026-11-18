import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createChildSafetyExtension } from "../extensions/child-safety.ts";
import { REQUESTED_TOOLS_ENV } from "../lib/agents-runner.ts";
import { markClaudeCompatGuardActive } from "../lib/claude-compat/guard-signal.ts";

// Runs in its own process (node --test isolates files), so the guard starts inactive.
function toolCallHandler(env: NodeJS.ProcessEnv) {
	let handler: ((event: { toolName: string; input: Record<string, unknown> }) => unknown) | undefined;
	createChildSafetyExtension(env)({ on: (_name: string, registered: typeof handler) => { handler = registered; } } as unknown as ExtensionAPI);
	return handler!;
}

test("the curated child fallback refuses an imported agent whose claude-compat guard is not loaded", () => {
	const imported = toolCallHandler({ GENTLE_PI_AGENTS_CHILD: "1", [REQUESTED_TOOLS_ENV]: "read,claude_policy_sample_auditor" });
	const native = toolCallHandler({ GENTLE_PI_AGENTS_CHILD: "1", [REQUESTED_TOOLS_ENV]: "read" });
	const call = { toolName: "read", input: { path: "notes.txt" } };
	assert.match((imported(call) as { reason: string }).reason, /claude-compat policy guard is not loaded/);
	assert.equal(native(call), undefined);
	markClaudeCompatGuardActive();
	assert.equal(imported(call), undefined, "with the guard loaded, the policy guard decides");
});
