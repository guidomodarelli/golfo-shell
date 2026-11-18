import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { createClaudeCompatExtension } from "../extensions/claude-compat.ts";
import { REQUESTED_TOOLS_ENV } from "../lib/agents-runner.ts";
import { BASH_BACKGROUND_TOOL, MONITOR_TOOL } from "../lib/background-jobs.ts";
import { CLAUDE_COMPAT_CONFIG_SCHEMA } from "../lib/claude-compat/constants.ts";
import { formatClaudeCompatReport } from "../lib/claude-compat/report.ts";
import { claudeCompatStatePath, synchronizeClaudeCompat } from "../lib/claude-compat/sync.ts";
import { agentFile, createClaudeFixture, skillFile } from "./claude-compat-fixtures.ts";

type ToolCallPlan = { name: string; arguments: Record<string, unknown> };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** Offline provider: issues the planned tool calls, then records the tool results it receives. */
async function offlineRuntime(agentHome: string, plan: ToolCallPlan[], results: Array<{ name: string; text: string; isError: boolean }>) {
	const runtime = await ModelRuntime.create({ authPath: join(agentHome, "offline-auth.json"), modelsPath: null, refreshOnCreate: false });
	let turn = 0;
	runtime.registerProvider("offline-compat", {
		api: "offline-compat-test", apiKey: "offline-dummy", baseUrl: "http://offline.invalid",
		models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
		streamSimple(model, context) {
			for (const message of context.messages) {
				if (message.role === "toolResult" && !results.some((result) => result.name === `${message.toolCallId}`)) {
					results.push({ name: message.toolCallId, text: message.content.map((part) => part.type === "text" ? part.text : "").join(""), isError: message.isError });
				}
			}
			const stream = createAssistantMessageEventStream();
			const calls = turn++ === 0 ? plan : [];
			const message: AssistantMessage = {
				role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), usage,
				content: (calls.length > 0 ? calls.map((call, index) => ({ type: "toolCall" as const, id: `${call.name}-${index}`, name: call.name, arguments: call.arguments })) : [{ type: "text" as const, text: "done" }]) as AssistantMessage["content"],
				stopReason: calls.length > 0 ? "toolUse" : "stop",
			};
			queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: message.stopReason as "stop", message }); stream.end(); });
			return stream;
		},
	});
	return runtime;
}

async function startSession(options: { root: string; agentHome: string; env: NodeJS.ProcessEnv; home: string; configHome: string; tools: string[]; plan: ToolCallPlan[] }) {
	const results: Array<{ name: string; text: string; isError: boolean }> = [];
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const runtime = await offlineRuntime(options.agentHome, options.plan, results);
	const loader = new DefaultResourceLoader({ cwd: options.root, agentDir: options.agentHome, settingsManager, noExtensions: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [createClaudeCompatExtension({ env: options.env, home: options.home, agentHome: options.agentHome, configHome: options.configHome })] });
	await loader.reload();
	const { session } = await createAgentSession({ cwd: options.root, agentDir: options.agentHome, modelRuntime: runtime, model: runtime.getModel("offline-compat", "fixture")!, resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(), tools: options.tools });
	await session.bindExtensions({ mode: "json" });
	return { session, loader, results };
}

test("real Pi session: an imported agent's child is held to its allowlist and Bash patterns", async () => {
	const fixture = createClaudeFixture();
	try {
		fixture.plugin({ key: "sample@market", version: "1.0.0", files: { "agents/auditor.md": agentFile({ name: "auditor", description: "Audits", tools: "Read, Bash(git status)" }) } });
		fixture.finalize();
		const state = synchronizeClaudeCompat({ home: fixture.home, agentHome: fixture.agentHome, configHome: fixture.configHome, nativeSkillDirectories: [] });
		const [policy] = state.policies;
		writeFileSync(join(fixture.root, "notes.txt"), "readable");
		const env = { GENTLE_PI_AGENTS_CHILD: "1", [REQUESTED_TOOLS_ENV]: policy.tools.join(",") };
		const { session, results } = await startSession({ ...fixture, env, tools: ["read", "bash", "write"], plan: [
			{ name: "bash", arguments: { command: "git push --force" } },
			{ name: "bash", arguments: { command: "git status && rm -rf data" } },
			{ name: "write", arguments: { path: join(fixture.root, "x.txt"), content: "x" } },
			{ name: "read", arguments: { path: join(fixture.root, "notes.txt") } },
		] });
		try {
			await session.prompt("Audit the repository.");
			const byId = Object.fromEntries(results.map((result) => [result.name, result]));
			assert.match(byId["bash-0"].text, /claude-compat: comando fuera de la allowlist/);
			assert.match(byId["bash-1"].text, /claude-compat: orden restringida rechazada/);
			assert.match(byId["write-2"].text, /claude-compat: herramienta write fuera de la allowlist/);
			assert.equal(byId["read-3"].isError, false);
			assert.match(byId["read-3"].text, /readable/);
		} finally { session.dispose(); }
	} finally { fixture.dispose(); }
});

test("real Pi session: an unreadable import blocks imported children instead of leaving them open", async () => {
	const fixture = createClaudeFixture();
	try {
		mkdirSync(join(fixture.agentHome, "claude-import"), { recursive: true });
		writeFileSync(claudeCompatStatePath(fixture.agentHome), "{ corrupt");
		writeFileSync(join(fixture.root, "notes.txt"), "readable");
		const env = { GENTLE_PI_AGENTS_CHILD: "1", [REQUESTED_TOOLS_ENV]: "read,claude_policy_sample_auditor" };
		const { session, results } = await startSession({ ...fixture, env, tools: ["read"], plan: [{ name: "read", arguments: { path: join(fixture.root, "notes.txt") } }] });
		try {
			await session.prompt("Read.");
			assert.match(results[0].text, /claude-compat: política de agente importado desconocida/);
		} finally { session.dispose(); }
		const plain = await startSession({ ...fixture, env: { GENTLE_PI_AGENTS_CHILD: "1", [REQUESTED_TOOLS_ENV]: "read" }, tools: ["read"], plan: [{ name: "read", arguments: { path: join(fixture.root, "notes.txt") } }] });
		try {
			await plain.session.prompt("Read.");
			assert.equal(plain.results[0].isError, false, "children of native agents are unaffected");
		} finally { plain.session.dispose(); }
	} finally { fixture.dispose(); }
});

test("real Pi loader: selected skills load through resources_discover without collisions", async () => {
	const fixture = createClaudeFixture();
	try {
		fixture.plugin({ key: "alpha@market", version: "1.0.0", files: { "skills/report/SKILL.md": skillFile("alpha:report"), "skills/shared/SKILL.md": skillFile("shared") } });
		fixture.plugin({ key: "beta@market", version: "1.0.0", files: { "skills/shared/SKILL.md": skillFile("shared", "beta") } });
		fixture.finalize();
		synchronizeClaudeCompat({ home: fixture.home, agentHome: fixture.agentHome, configHome: fixture.configHome, nativeSkillDirectories: [] });
		const { session, loader } = await startSession({ ...fixture, env: {}, tools: ["read"], plan: [] });
		try {
			const skills = loader.getSkills();
			const imported = skills.skills.filter((skill) => ["alpha-report", "shared"].includes(skill.name));
			assert.deepEqual(imported.map((skill) => skill.name).sort(), ["alpha-report", "shared"]);
			const collisions = skills.diagnostics.filter((diagnostic) => diagnostic.type === "collision" && /alpha-report|"shared"/.test(diagnostic.message));
			assert.deepEqual(collisions, [], "the imported catalog introduces no collision diagnostics");
		} finally { session.dispose(); }
	} finally { fixture.dispose(); }
});

type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;
function harness(env: NodeJS.ProcessEnv, fixture: ReturnType<typeof createClaudeFixture>) {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
	const pi = {
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		registerTool() {}, getCommands: () => [],
		registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => commands.set(name, command),
	} as unknown as ExtensionAPI;
	createClaudeCompatExtension({ env, home: fixture.home, agentHome: fixture.agentHome, configHome: fixture.configHome })(pi);
	return { handlers, commands };
}

test("a reviewed PreToolUse hook's ask needs a fresh human confirmation and fails closed without one", async () => {
	const fixture = createClaudeFixture();
	try {
		fixture.plugin({ key: "guard@market", version: "1.0.0", files: { "hooks/ask.mjs": "process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'ask',permissionDecisionReason:'confirmar push'}}))" } });
		fixture.finalize();
		writeFileSync(join(fixture.configHome, "claude-compat.json"), JSON.stringify({ schema: CLAUDE_COMPAT_CONFIG_SCHEMA, hooks: [{ id: "ask", plugin: "guard", script: "hooks/ask.mjs", event: "PreToolUse", tools: ["Bash"] }] }));
		synchronizeClaudeCompat({ home: fixture.home, agentHome: fixture.agentHome, configHome: fixture.configHome, nativeSkillDirectories: [] });
		const event = { toolName: "bash", toolCallId: "1", input: { command: "git push" } };
		const context = (hasUI: boolean, answer: boolean, prompts: string[]) => ({ cwd: fixture.root, hasUI, signal: undefined, sessionManager: { getSessionId: () => "session" }, ui: { confirm: async (title: string) => { prompts.push(title); return answer; }, notify() {} } }) as unknown as ExtensionContext;
		const primary = harness({}, fixture).handlers.get("tool_call")!;
		const prompts: string[] = [];
		assert.equal(await primary(event, context(true, true, prompts)), undefined);
		assert.equal(await primary(event, context(true, true, prompts)), undefined);
		assert.equal(prompts.length, 2, "approval is never cached");
		assert.equal((await primary(event, context(true, false, prompts)) as { block: boolean }).block, true);
		assert.equal((await primary(event, context(false, true, [])) as { block: boolean }).block, true, "headless cannot confirm");
		assert.equal(await primary({ ...event, toolName: "read", input: { path: "x" } }, context(true, false, [])), undefined, "hook matcher limits it to Bash");
		const child = harness({ GENTLE_PI_AGENTS_CHILD: "1" }, fixture).handlers.get("tool_call")!;
		assert.equal((await child(event, context(true, true, [])) as { block: boolean }).block, true, "children never prompt");
	} finally { fixture.dispose(); }
});

test("a reviewed PreToolUse hook sees Claude Code's tool_input: a .env guard blocks Pi writes and unrepresentable input fails closed", async () => {
	const fixture = createClaudeFixture();
	try {
		const envGuard = "let data='';process.stdin.on('data',(c)=>data+=c).on('end',()=>{const p=JSON.parse(data);const f=String(p.tool_input.file_path??'');process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:f.endsWith('.env')?'deny':'allow',permissionDecisionReason:p.tool_name+' '+f}}))});";
		fixture.plugin({ key: "guard@market", version: "1.0.0", files: { "hooks/env.mjs": envGuard } });
		fixture.finalize();
		writeFileSync(join(fixture.configHome, "claude-compat.json"), JSON.stringify({ schema: CLAUDE_COMPAT_CONFIG_SCHEMA, hooks: [{ id: "env", plugin: "guard", script: "hooks/env.mjs", event: "PreToolUse", tools: ["Write", "Edit"] }] }));
		synchronizeClaudeCompat({ home: fixture.home, agentHome: fixture.agentHome, configHome: fixture.configHome, nativeSkillDirectories: [] });
		const context = { cwd: fixture.root, hasUI: false, signal: undefined, sessionManager: { getSessionId: () => "session" }, ui: { confirm: async () => false, notify() {} } } as unknown as ExtensionContext;
		const toolCall = harness({}, fixture).handlers.get("tool_call")!;
		const call = (toolName: string, input: Record<string, unknown>) => toolCall({ toolName, toolCallId: "1", input }, context) as Promise<{ block: boolean; reason: string } | undefined>;
		const denied = await call("write", { path: "x/.env", content: "SECRET=1" });
		assert.equal(denied?.block, true, "the guard reads tool_input.file_path");
		assert.match(denied!.reason, /Write .*\.env/);
		assert.equal(await call("write", { path: "x/app.ts", content: "" }), undefined);
		assert.match((await call("edit", { path: "x/.env", edits: [{ oldText: "a", newText: "b" }, { oldText: "c", newText: "d" }] }))!.reason, /MultiEdit .*\.env/, "Edit matcher covers MultiEdit");
		const unrepresentable = await call("edit", { path: "x/app.ts", edits: [] });
		assert.equal(unrepresentable?.block, true);
		assert.match(unrepresentable!.reason, /no se puede representar/);
	} finally { fixture.dispose(); }
});

test("a reviewed Bash PreToolUse guard also blocks the same command launched through bash_background or monitor", async () => {
	const fixture = createClaudeFixture();
	try {
		const rmGuard = "let data='';process.stdin.on('data',(c)=>data+=c).on('end',()=>{const p=JSON.parse(data);const c=String(p.tool_input.command??'');process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:/rm -rf/.test(c)?'deny':'allow',permissionDecisionReason:p.tool_name+' '+c+' background='+p.tool_input.run_in_background}}))});";
		fixture.plugin({ key: "guard@market", version: "1.0.0", files: { "hooks/rm.mjs": rmGuard } });
		fixture.finalize();
		writeFileSync(join(fixture.configHome, "claude-compat.json"), JSON.stringify({ schema: CLAUDE_COMPAT_CONFIG_SCHEMA, hooks: [{ id: "rm", plugin: "guard", script: "hooks/rm.mjs", event: "PreToolUse", tools: ["Bash"] }] }));
		synchronizeClaudeCompat({ home: fixture.home, agentHome: fixture.agentHome, configHome: fixture.configHome, nativeSkillDirectories: [] });
		const context = { cwd: fixture.root, hasUI: false, signal: undefined, sessionManager: { getSessionId: () => "session" }, ui: { confirm: async () => false, notify() {} } } as unknown as ExtensionContext;
		const toolCall = harness({}, fixture).handlers.get("tool_call")!;
		const call = (toolName: string, input: Record<string, unknown>) => toolCall({ toolName, toolCallId: "1", input }, context) as Promise<{ block: boolean; reason: string } | undefined>;
		for (const [toolName, input] of [["bash", { command: "rm -rf data" }], [BASH_BACKGROUND_TOOL, { command: "rm -rf data" }], [MONITOR_TOOL, { command: "rm -rf data", timeout_seconds: 30 }]] as const) {
			const denied = await call(toolName, input);
			assert.equal(denied?.block, true, `${toolName} runs through the Bash guard`);
			assert.match(denied!.reason, /Bash rm -rf data/);
			assert.equal(await call(toolName, { ...input, command: "ls" }), undefined, `${toolName} keeps running commands the guard allows`);
		}
		assert.match((await call(BASH_BACKGROUND_TOOL, { command: "rm -rf data" }))!.reason, /background=true/);
		const unrepresentable = await call(BASH_BACKGROUND_TOOL, { command: 1 });
		assert.equal(unrepresentable?.block, true);
		assert.match(unrepresentable!.reason, /no se puede representar/);
	} finally { fixture.dispose(); }
});

test("a reviewed PreToolUse guard whose script was removed fails closed; a missing SessionStart hook is only reported", async () => {
	const fixture = createClaudeFixture();
	try {
		fixture.plugin({ key: "guard@market", version: "1.0.0", files: { "hooks/other.mjs": "" } });
		fixture.finalize();
		writeFileSync(join(fixture.configHome, "claude-compat.json"), JSON.stringify({ schema: CLAUDE_COMPAT_CONFIG_SCHEMA, hooks: [
			{ id: "push-guard", plugin: "guard", script: "hooks/push.mjs", event: "PreToolUse", tools: ["Bash"] },
			{ id: "context", plugin: "guard", script: "hooks/context.mjs", event: "SessionStart" },
		] }));
		const state = synchronizeClaudeCompat({ home: fixture.home, agentHome: fixture.agentHome, configHome: fixture.configHome, nativeSkillDirectories: [] });
		assert.deepEqual(state.hooks.map((hook) => [hook.id, hook.script, hook.unavailable]), [["push-guard", undefined, "script hooks/push.mjs no existe en guard"]]);
		assert.equal(state.hookErrors.length, 2);
		assert.match(state.hookErrors[1], /context: script hooks\/context\.mjs no existe/);
		assert.match(formatClaudeCompatReport(state), /Guards no disponibles[^\n]*:\n {2}- push-guard: Bash/);
		const notices: string[] = [];
		const context = { cwd: fixture.root, hasUI: true, signal: undefined, sessionManager: { getSessionId: () => "session" }, ui: { confirm: async () => true, notify: (text: string) => notices.push(text) } } as unknown as ExtensionContext;
		const { handlers } = harness({}, fixture);
		const blocked = await handlers.get("tool_call")!({ toolName: "bash", toolCallId: "1", input: { command: "git push" } }, context) as { block: boolean; reason: string };
		assert.equal(blocked.block, true);
		assert.match(blocked.reason, /guard push-guard no disponible \(script hooks\/push\.mjs no existe en guard\)/);
		assert.equal(await handlers.get("tool_call")!({ toolName: "read", toolCallId: "2", input: { path: "x" } }, context), undefined, "the guard only covers Bash");
		await handlers.get("session_start")!({ reason: "startup" }, context);
		assert.deepEqual(notices, [], "a missing context hook is not in the state, so it never runs nor blocks");
	} finally { fixture.dispose(); }
});

test("an unavailable PreToolUse guard configured with a Claude Code MCP name blocks the normalized Pi MCP call", async () => {
	const fixture = createClaudeFixture();
	try {
		fixture.plugin({ key: "guard@market", version: "1.0.0", files: { "hooks/other.mjs": "" } });
		fixture.finalize();
		writeFileSync(join(fixture.configHome, "claude-compat.json"), JSON.stringify({ schema: CLAUDE_COMPAT_CONFIG_SCHEMA, hooks: [
			{ id: "publish-guard", plugin: "guard", script: "hooks/publish.mjs", event: "PreToolUse", tools: ["mcp__dev-docs__publish"] },
		] }));
		const state = synchronizeClaudeCompat({ home: fixture.home, agentHome: fixture.agentHome, configHome: fixture.configHome, nativeSkillDirectories: [] });
		assert.equal(state.hooks[0].unavailable, "script hooks/publish.mjs no existe en guard");
		const context = { cwd: fixture.root, hasUI: true, signal: undefined, sessionManager: { getSessionId: () => "session" }, ui: { confirm: async () => true, notify: () => {} } } as unknown as ExtensionContext;
		const { handlers } = harness({}, fixture);
		const blocked = await handlers.get("tool_call")!({ toolName: "mcp__dev_docs__publish", toolCallId: "1", input: { page: "x" } }, context) as { block: boolean; reason: string };
		assert.equal(blocked.block, true);
		assert.match(blocked.reason, /guard publish-guard no disponible/);
		assert.equal(await handlers.get("tool_call")!({ toolName: "mcp__dev_docs__read", toolCallId: "2", input: {} }, context), undefined, "the guard only covers publish");
	} finally { fixture.dispose(); }
});

test("an unreadable state keeps the configured PreToolUse guards blocking, refuses every call without a readable config, and leaves guard-free sessions working", async () => {
	const fixture = createClaudeFixture();
	try {
		mkdirSync(join(fixture.agentHome, "claude-import"), { recursive: true });
		writeFileSync(claudeCompatStatePath(fixture.agentHome), "{ corrupt");
		const notices: string[] = [];
		const context = { cwd: fixture.root, hasUI: true, signal: undefined, sessionManager: { getSessionId: () => "session" }, ui: { confirm: async () => true, notify: (text: string) => notices.push(text) } } as unknown as ExtensionContext;
		const bashCall = { toolName: "bash", toolCallId: "1", input: { command: "git push" } };
		const readCall = { toolName: "read", toolCallId: "2", input: { path: "x" } };

		const unguarded = harness({}, fixture).handlers;
		assert.equal(await unguarded.get("tool_call")!(bashCall, context), undefined, "without claude-compat.json the main session keeps working");
		assert.equal(await unguarded.get("tool_call")!(readCall, context), undefined);

		const configPath = join(fixture.configHome, "claude-compat.json");
		writeFileSync(configPath, JSON.stringify({ schema: CLAUDE_COMPAT_CONFIG_SCHEMA, hooks: [{ id: "push-guard", plugin: "guard", script: "hooks/push.mjs", event: "PreToolUse", tools: ["Bash"] }] }));
		const guarded = harness({}, fixture).handlers;
		const blocked = await guarded.get("tool_call")!(bashCall, context) as { block: boolean; reason: string };
		assert.equal(blocked.block, true);
		assert.match(blocked.reason, /guard push-guard no disponible \(estado de importación ilegible; reparar o ejecutar \/claude-compat:sync\)/);
		assert.equal(await guarded.get("tool_call")!(readCall, context), undefined, "the guard only covers Bash");
		const nativeChild = harness({ GENTLE_PI_AGENTS_CHILD: "1", [REQUESTED_TOOLS_ENV]: "bash" }, fixture).handlers;
		assert.equal((await nativeChild.get("tool_call")!(bashCall, context) as { block: boolean }).block, true, "children of native agents keep the guard");
		await guarded.get("session_start")!({ reason: "startup" }, context);
		assert.match(notices.at(-1)!, /herramientas que cubren los guards configurados quedan bloqueados/);

		writeFileSync(configPath, "{ broken");
		const blind = harness({}, fixture).handlers;
		for (const call of [bashCall, readCall]) {
			const refused = await blind.get("tool_call")!(call, context) as { block: boolean; reason: string };
			assert.equal(refused.block, true, `${call.toolName} is refused when no guard list can be read`);
			assert.match(refused.reason, /Reparar claude-compat\.json y state\.json y ejecutar \/claude-compat:sync/);
		}
	} finally { fixture.dispose(); }
});

test("sync and status commands report the import; children get no import commands", async () => {
	const fixture = createClaudeFixture();
	try {
		fixture.plugin({ key: "sample@market", version: "1.0.0", files: { "skills/report/SKILL.md": skillFile("sample:report") } });
		fixture.finalize();
		const notices: Array<{ text: string; level: string }> = [];
		let reloads = 0;
		const context = { ui: { notify: (text: string, level: string) => notices.push({ text, level }) }, reload: async () => { reloads++; } } as unknown as ExtensionContext;
		const { commands } = harness({}, fixture);
		await commands.get("claude-compat:sync")!.handler("", context);
		assert.equal(reloads, 1);
		assert.match(notices[0].text, /sample:report → sample-report/);
		assert.deepEqual([...harness({ GENTLE_PI_AGENTS_CHILD: "1" }, fixture).commands.keys()], []);
		writeFileSync(join(fixture.configHome, "claude-compat.json"), "{ broken");
		await commands.get("claude-compat:sync")!.handler("", context);
		assert.equal(notices[1].level, "error");
		assert.equal(reloads, 1, "a failed import is not applied");
	} finally { fixture.dispose(); }
});
