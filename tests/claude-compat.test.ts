import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { assertRestrictedCommand, enforceAgentPolicy, parseCommandPattern, PolicyViolation, resolveChildPolicy } from "../lib/claude-compat/agent-policy.ts";
import { splitToolList, translateTools } from "../lib/claude-compat/agents.ts";
import { loadClaudeCompatConfig } from "../lib/claude-compat/config.ts";
import { CLAUDE_COMPAT_CONFIG_SCHEMA } from "../lib/claude-compat/constants.ts";
import { callReviewedHook, decodeHookResult } from "../lib/claude-compat/hooks.ts";
import { runProcess } from "../lib/claude-compat/process.ts";
import { formatClaudeCompatReport } from "../lib/claude-compat/report.ts";
import { normalizeSkillName } from "../lib/claude-compat/skills.ts";
import { claudeCompatStatePath, synchronizeClaudeCompat } from "../lib/claude-compat/sync.ts";
import { agentFile, createClaudeFixture, skillFile } from "./claude-compat-fixtures.ts";

const REQUESTED = "GENTLE_PI_AGENTS_REQUESTED_TOOLS";

function sync(fixture: ReturnType<typeof createClaudeFixture>) {
	return synchronizeClaudeCompat({ home: fixture.home, agentHome: fixture.agentHome, configHome: fixture.configHome, nativeSkillDirectories: [join(fixture.agentHome, "skills")] });
}

test("skill selection is deterministic: enabled plugins first, one winner per name, legacy-only skills kept", () => {
	const fixture = createClaudeFixture();
	try {
		fixture.plugin({ key: "beta@market", version: "1.0.0", files: { "skills/report/SKILL.md": skillFile("report", "beta report") } });
		fixture.plugin({ key: "alpha@market", version: "1.0.0", files: { "skills/report/SKILL.md": skillFile("report", "alpha old"), "skills/legacy-only/SKILL.md": skillFile("legacy-only") } });
		fixture.plugin({ key: "alpha@market", version: "2.0.0", files: { "skills/report/SKILL.md": skillFile("report", "alpha new") } });
		fixture.write("home/.claude/skills/report/SKILL.md", skillFile("report", "legacy user report"));
		fixture.write("home/.claude/skills/personal/SKILL.md", skillFile("personal"));
		fixture.finalize();
		const state = sync(fixture);
		const winners = Object.fromEntries(state.skills.map((skill) => [skill.name, skill]));
		assert.deepEqual(Object.keys(winners).sort(), ["legacy-only", "personal", "report"]);
		assert.match(readFileSync(winners.report.file, "utf8"), /alpha new/, "newest install of the first enabled plugin wins");
		assert.equal(winners["legacy-only"].owner, "alpha@market", "a skill only an older install has is preserved");
		assert.equal(state.duplicates.filter((duplicate) => duplicate.name === "report").length, 3);
		assert.equal(new Set(state.skills.map((skill) => skill.name)).size, state.skills.length, "no imported collisions");
	} finally { fixture.dispose(); }
});

test("names already loaded natively by Pi keep priority over imported skills", () => {
	const fixture = createClaudeFixture();
	try {
		fixture.plugin({ key: "alpha@market", version: "1.0.0", files: { "skills/review/SKILL.md": skillFile("review") } });
		fixture.write("agent/skills/review/SKILL.md", skillFile("review", "native"));
		fixture.finalize();
		const state = sync(fixture);
		assert.deepEqual(state.skills, []);
		assert.deepEqual(state.duplicates.map((duplicate) => duplicate.selected), ["pi-native"]);
	} finally { fixture.dispose(); }
});

test("non-portable names are adapted in the derived cache with their resources; originals stay intact", () => {
	const fixture = createClaudeFixture();
	try {
		const root = fixture.plugin({ key: "sample@market", version: "1.0.0", files: {
			"skills/report/SKILL.md": skillFile("sample:report"),
			"skills/report/references/guide.md": "guide",
			"skills/report/scripts/run.sh": "echo run",
		} });
		fixture.finalize();
		const original = readFileSync(join(root, "skills/report/SKILL.md"), "utf8");
		const state = sync(fixture);
		const [skill] = state.skills;
		assert.equal(skill.name, "sample-report");
		assert.equal(skill.adapted, true);
		assert.ok(skill.file.startsWith(join(fixture.agentHome, "claude-import", "skills", "sample-report")));
		assert.match(readFileSync(skill.file, "utf8"), /^---\nname: sample-report\n/);
		assert.equal(readFileSync(join(skill.file, "..", "references", "guide.md"), "utf8"), "guide");
		assert.equal(readFileSync(join(skill.file, "..", "scripts", "run.sh"), "utf8"), "echo run");
		assert.equal(readFileSync(join(root, "skills/report/SKILL.md"), "utf8"), original);
		assert.equal(normalizeSkillName("Sample Report!"), "sample-report");
		assert.equal(normalizeSkillName(":::"), undefined);
	} finally { fixture.dispose(); }
});

test("adapted skill resources keep the owner execute bit and stay private to group and others", { skip: process.platform === "win32" }, () => {
	const fixture = createClaudeFixture();
	try {
		const root = fixture.plugin({ key: "sample@market", version: "1.0.0", files: {
			"skills/report/SKILL.md": skillFile("sample:report"),
			"skills/report/references/guide.md": "guide",
			"skills/report/scripts/run.sh": "echo run",
		} });
		chmodSync(join(root, "skills/report/scripts/run.sh"), 0o755);
		chmodSync(join(root, "skills/report/references/guide.md"), 0o644);
		fixture.finalize();
		const [skill] = sync(fixture).skills;
		const scriptMode = statSync(join(skill.file, "..", "scripts", "run.sh")).mode;
		assert.ok(scriptMode & 0o100, "the copied script stays executable by its owner");
		assert.equal(scriptMode & 0o077, 0, "the copied script is not readable by group or others");
		assert.equal(statSync(join(skill.file, "..", "references", "guide.md")).mode & 0o777, 0o600);
		const [resynchronized] = sync(fixture).skills;
		assert.ok(statSync(join(resynchronized.file, "..", "scripts", "run.sh")).mode & 0o100, "a second sync keeps the execute bit");
	} finally { fixture.dispose(); }
});

test("only enabled user-scope plugins are imported; project scopes and native equivalents are reported", () => {
	const fixture = createClaudeFixture();
	try {
		fixture.plugin({ key: "local@market", version: "1.0.0", scope: "project", files: { "skills/local/SKILL.md": skillFile("local") } });
		fixture.plugin({ key: "off@market", version: "1.0.0", enabled: false, files: { "skills/off/SKILL.md": skillFile("off") } });
		fixture.plugin({ key: "engram@market", version: "1.0.0", files: { "skills/memory/SKILL.md": skillFile("memory") } });
		fixture.finalize();
		const state = sync(fixture);
		assert.deepEqual(state.skills, []);
		const reasons = Object.fromEntries(state.skippedPlugins.map((plugin) => [plugin.key, plugin.reason]));
		assert.match(reasons["local@market"], /scope de proyecto/);
		assert.match(reasons["off@market"], /deshabilitado/);
		assert.match(reasons["engram@market"], /equivalente nativo/);
		assert.ok(state.hookInventory.some((entry) => entry.origin === "engram@market" && entry.classification === "native-equivalent"));
	} finally { fixture.dispose(); }
});

test("derived files edited by the user are never overwritten; intact ones are pruned when their source leaves", () => {
	const fixture = createClaudeFixture();
	try {
		fixture.plugin({ key: "sample@market", version: "1.0.0", files: { "skills/report/SKILL.md": skillFile("sample:report"), "agents/helper.md": agentFile({ name: "helper", description: "helper", tools: "Read" }) } });
		fixture.finalize();
		const first = sync(fixture);
		const skillCopy = first.skills[0].file;
		const agent = first.agents[0].file;
		writeFileSync(skillCopy, "user edit");
		const second = sync(fixture);
		assert.equal(readFileSync(skillCopy, "utf8"), "user edit");
		assert.match(second.skippedSkills[0].reason, /modified outside the importer/);
		fixture.finalize();
		writeFileSync(join(fixture.home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: {} }));
		const third = sync(fixture);
		assert.equal(existsSync(agent), false, "intact derived agent is removed");
		assert.deepEqual(third.agents, []);
		assert.equal(readFileSync(skillCopy, "utf8"), "user edit", "user-edited copy survives");
	} finally { fixture.dispose(); }
});

test("agents keep exact allowlists, report missing tools and never import permission bypass", () => {
	const fixture = createClaudeFixture();
	try {
		fixture.plugin({ key: "sample@market", version: "1.0.0", files: {
			"agents/auditor.md": agentFile({ name: "auditor", description: "Audits", tools: "Read, Grep, Bash(git status), Bash(git diff *), Task, WebFetch, mcp__dev-docs__search", model: "inherit", effort: "high", permissionMode: "bypassPermissions" }),
			"agents/open.md": agentFile({ name: "open", description: "Open", tools: "Read, Bash" }),
			"agents/everything.md": agentFile({ name: "everything", description: "No list" }),
		} });
		fixture.finalize();
		const state = sync(fixture);
		const auditor = state.policies.find((policy) => policy.name === "claude-sample-auditor")!;
		assert.deepEqual(auditor.tools.sort(), ["bash", "claude_policy_sample_auditor", "grep", "mcp__dev_docs__search", "read", "subagent_parent_message"]);
		assert.equal(auditor.unrestrictedBash, false);
		assert.deepEqual(auditor.commandPatterns.map((pattern) => pattern.source), ["git status", "git diff *"]);
		assert.deepEqual(auditor.unsupported, ["Task", "WebFetch"]);
		const file = readFileSync(state.agents.find((agent) => agent.name === "claude-sample-auditor")!.file, "utf8");
		assert.doesNotMatch(file, /^permissionMode:/m);
		assert.doesNotMatch(file, /^model:/m, "inherit keeps the parent's model");
		assert.match(file, /^thinking: high$/m);
		assert.match(file, /^tools: .*claude_policy_sample_auditor/m);
		assert.equal(state.policies.find((policy) => policy.name === "claude-sample-open")!.unrestrictedBash, true);
		assert.match(state.agentErrors[0].reason, /sin allowlist explícita/);
		const report = formatClaudeCompatReport(state);
		assert.match(report, /Task, WebFetch/);
		assert.match(report, /bypassPermissions \(omite permisos; nunca se importa\)/);
	} finally { fixture.dispose(); }
});

test("agents whose policy markers collide are rejected before writing, so no restricted agent inherits another policy", () => {
	const fixture = createClaudeFixture();
	try {
		fixture.plugin({ key: "sample@market", version: "1.0.0", files: {
			"agents/first.md": agentFile({ name: "a-b", description: "Open", tools: "Read, Bash" }),
			"agents/second.md": agentFile({ name: "a_b", description: "Restricted", tools: "Read" }),
			"agents/third.md": agentFile({ name: "A-B", description: "Restricted", tools: "Read" }),
		} });
		fixture.finalize();
		const state = sync(fixture);
		assert.deepEqual(state.policies.map((policy) => policy.marker), ["claude_policy_sample_a_b"]);
		assert.equal(state.agents.length, 1);
		assert.equal(state.agentErrors.length, 2);
		for (const error of state.agentErrors) assert.match(error.reason, /marker de política claude_policy_sample_a_b ya usado/);
		assert.ok(state.agents.every((agent) => existsSync(agent.file)));
		const shared = { ...state.policies[0], name: "claude-sample-a_b" };
		assert.throws(() => resolveChildPolicy({ GENTLE_PI_AGENTS_CHILD: "1", [REQUESTED]: shared.marker }, REQUESTED, [state.policies[0], shared]), /compartido por varios agentes/);
	} finally { fixture.dispose(); }
});

test("disallowedTools removes denied tools from the allowlist and rejects denials it cannot enforce", () => {
	const fixture = createClaudeFixture();
	try {
		fixture.plugin({ key: "sample@market", version: "1.0.0", files: {
			"agents/reader.md": agentFile({ name: "reader", description: "Reads", tools: "Read, Write, Bash(git status), mcp__docs__search, mcp__docs__write", disallowedTools: "[Write, Bash, mcp__docs__write]" }),
			"agents/pusher.md": agentFile({ name: "pusher", description: "Pushes", tools: "Read, Bash", disallowedTools: "Bash(git push)" }),
			"agents/wildcard.md": agentFile({ name: "wildcard", description: "Wildcard", tools: "Read, mcp__docs", disallowedTools: "mcp__docs__*" }),
		} });
		fixture.finalize();
		const state = sync(fixture);
		const reader = state.policies.find((policy) => policy.name === "claude-sample-reader")!;
		assert.deepEqual(reader.tools.sort(), ["claude_policy_sample_reader", "mcp__docs__search", "read", "subagent_parent_message"]);
		assert.equal(reader.unrestrictedBash, false);
		assert.deepEqual(reader.commandPatterns, []);
		assert.throws(() => enforceAgentPolicy(reader, "write", {}), PolicyViolation);
		assert.deepEqual(state.agents.find((agent) => agent.name === "claude-sample-reader")!.omitted, ["tools quitadas por disallowedTools: Write, Bash(git status), mcp__docs__write"]);
		assert.equal(state.policies.some((policy) => policy.name === "claude-sample-pusher" || policy.name === "claude-sample-wildcard"), false);
		const reasons = state.agentErrors.map((error) => error.reason);
		assert.ok(reasons.some((reason) => /Bash\(git push\) no se puede representar con seguridad.*requiere adaptación manual/.test(reason)));
		assert.ok(reasons.some((reason) => /mcp__docs__\* no se puede representar con seguridad/.test(reason)));
		assert.equal(existsSync(join(fixture.agentHome, "agents", "claude-sample-pusher.md")), false);
	} finally { fixture.dispose(); }
});

test("Bash(pattern) accepts one simple argv and blocks shell syntax it cannot represent", () => {
	const patterns = ["git status", "git diff *", "npm run test:*"].map((source) => parseCommandPattern(source)!);
	for (const command of ["git status", "git diff", "git diff --stat src/a.ts", "npm run test", "npm run test --watch=false"]) {
		assert.deepEqual(assertRestrictedCommand(command, patterns), command.split(" "));
	}
	for (const command of ["git status; rm -rf data", "git status && git push", "git diff $(whoami)", "git diff `id`", "git status > out", "git diff 'a b'", "git push", "git status --short", "git  status", "", 42]) {
		assert.throws(() => assertRestrictedCommand(command, patterns), PolicyViolation, String(command));
	}
	assert.equal(parseCommandPattern("git log | head"), undefined);
	assert.deepEqual(splitToolList("[Read, Bash(git diff, --stat), \"Grep\"]"), ["Read", "Bash(git diff, --stat)", "Grep"]);
	assert.deepEqual(translateTools(["Bash(echo $HOME)"]).unsupported, ["Bash(echo $HOME)"], "unrepresentable pattern is never widened");
});

test("child policy binding fails closed and covers MCP, delegation and nested tools", () => {
	const policy = { name: "claude-x", marker: "claude_policy_x", tools: ["read", "bash", "claude_policy_x", "subagent_parent_message"], toolPrefixes: ["mcp__docs"], unrestrictedBash: false, commandPatterns: [parseCommandPattern("git status")!], unsupported: [], source: "x.md" };
	const child = (tools: string) => ({ GENTLE_PI_AGENTS_CHILD: "1", [REQUESTED]: tools });
	assert.equal(resolveChildPolicy({ [REQUESTED]: "claude_policy_x" }, REQUESTED, [policy]), null, "primary sessions are not bound");
	assert.equal(resolveChildPolicy(child("read"), REQUESTED, [policy]), null);
	assert.equal(resolveChildPolicy(child("read,claude_policy_x"), REQUESTED, [policy]), policy);
	assert.throws(() => resolveChildPolicy(child("claude_policy_y"), REQUESTED, [policy]), /desconocida/);
	assert.throws(() => resolveChildPolicy(child("claude_policy_x"), REQUESTED, undefined), /desconocida/);
	assert.throws(() => resolveChildPolicy(child("claude_policy_x,claude_policy_y"), REQUESTED, [policy]), /varias políticas/);
	enforceAgentPolicy(policy, "read", {});
	enforceAgentPolicy(policy, "mcp__docs__search", {});
	enforceAgentPolicy(policy, "bash", { command: "git status" });
	for (const tool of ["write", "subagent", "codemode", "mcp__other__search", "mcp__docsextra__x", "powershell"]) {
		assert.throws(() => enforceAgentPolicy(policy, tool, {}), PolicyViolation, tool);
	}
	assert.throws(() => enforceAgentPolicy(policy, "bash", { command: "git status | sh" }), PolicyViolation);
});

test("hook decisions preserve deny and ask, never treat allow as consent, and fail closed", () => {
	const result = (stdout: string, code = 0) => ({ code, stdout, stderr: "" });
	const output = (specific: Record<string, unknown>) => JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", ...specific } });
	assert.deepEqual(decodeHookResult(result(output({ permissionDecision: "allow" })), true), { action: "continue" });
	assert.equal(decodeHookResult(result(output({ permissionDecision: "deny", permissionDecisionReason: "no" })), true).action, "block");
	assert.deepEqual(decodeHookResult(result(output({ permissionDecision: "ask", permissionDecisionReason: "seguro?" })), true), { action: "ask", reason: "seguro?" });
	assert.equal(decodeHookResult(result(JSON.stringify({ decision: "block", reason: "x" })), true).action, "block");
	assert.equal(decodeHookResult(result(JSON.stringify({ continue: false })), true).action, "block");
	for (const failure of [result("not json"), result("[]"), result("", 2), result(output({ permissionDecision: "maybe" })), result(output({ updatedInput: { command: "rm -rf /" } })), result(JSON.stringify({ continue: "no" }))]) {
		assert.equal(decodeHookResult(failure, true).action, "block", failure.stdout);
	}
	assert.throws(() => decodeHookResult(result("not json"), false), /JSON inválido/);
	assert.deepEqual(decodeHookResult(result(JSON.stringify({ hookSpecificOutput: { additionalContext: "ctx" } })), false), { action: "continue", context: "ctx" });
});

test("hook processes are bounded: timeout, oversized output and cancellation fail closed", async () => {
	const fixture = createClaudeFixture();
	try {
		const sleeper = fixture.write("hooks/sleep.mjs", "setTimeout(() => {}, 60_000);");
		const noisy = fixture.write("hooks/noisy.mjs", "process.stdout.write('x'.repeat(4096));");
		const echo = fixture.write("hooks/echo.mjs", "let data='';process.stdin.on('data',(c)=>data+=c).on('end',()=>{const p=JSON.parse(data);process.stdout.write(JSON.stringify({hookSpecificOutput:{permissionDecision:p.tool_input.command==='ok'?'allow':'deny',permissionDecisionReason:process.env.CLAUDE_PLUGIN_ROOT}}))});");
		await assert.rejects(runProcess(process.execPath, [sleeper], { cwd: fixture.root, timeoutMs: 200 }), /timed out/);
		await assert.rejects(runProcess(process.execPath, [noisy], { cwd: fixture.root, outputLimitBytes: 100 }), /exceeded/);
		const controller = new AbortController();
		const pending = runProcess(process.execPath, [sleeper], { cwd: fixture.root, signal: controller.signal });
		controller.abort();
		await assert.rejects(pending, /cancelled/);
		const hook = { id: "guard", event: "PreToolUse" as const, script: echo, root: fixture.root };
		const payload = (command: string) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });
		assert.deepEqual(await callReviewedHook(hook, payload("ok"), { cwd: fixture.root }), { action: "continue" });
		const denied = await callReviewedHook(hook, payload("rm"), { cwd: fixture.root });
		assert.equal(denied.action, "block");
		assert.match((denied as { reason: string }).reason, new RegExp(fixture.root.replaceAll("\\", "\\\\")), "CLAUDE_PLUGIN_ROOT is the plugin root");
		const timedOut = await callReviewedHook({ ...hook, script: sleeper }, payload("ok"), { cwd: fixture.root, signal: AbortSignal.timeout(200) });
		assert.equal(timedOut.action, "block");
	} finally { fixture.dispose(); }
});

test("reviewed hook allowlist is explicit and inventory separates adapted, native and pending hooks", () => {
	const fixture = createClaudeFixture();
	try {
		fixture.plugin({ key: "guard@market", version: "1.0.0", files: {
			"hooks/hooks.json": JSON.stringify({ hooks: {
				PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/hooks/check.mjs" }] }],
				Stop: [{ hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/hooks/stop.sh" }] }],
				Notification: [{ hooks: [{ type: "command", command: "notify.sh" }] }],
			} }),
			"hooks/check.mjs": "",
		} });
		fixture.finalize({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }] } });
		writeFileSync(join(fixture.configHome, "claude-compat.json"), JSON.stringify({ schema: CLAUDE_COMPAT_CONFIG_SCHEMA, hooks: [{ id: "check", plugin: "guard", script: "hooks/check.mjs", event: "PreToolUse", tools: ["Bash"] }, { id: "gone", plugin: "missing", script: "x.sh", event: "SessionStart" }] }));
		const state = sync(fixture);
		assert.deepEqual(state.hooks.map((hook) => hook.id), ["check"]);
		assert.match(state.hookErrors[0], /gone: plugin missing/);
		const byEvent = Object.fromEntries(state.hookInventory.filter((entry) => entry.origin !== "engram").map((entry) => [`${entry.origin}:${entry.event}`, entry.classification]));
		assert.equal(byEvent["guard@market:PreToolUse"], "adapted");
		assert.equal(byEvent["guard@market:Stop"], "pending");
		assert.equal(byEvent["guard@market:Notification"], "native-equivalent");
		assert.equal(byEvent["~/.claude/settings.json:SessionStart"], "pending");
		const report = formatClaudeCompatReport(state);
		assert.ok(report.indexOf("Hooks adaptados") < report.indexOf("Equivalentes nativos") && report.indexOf("Equivalentes nativos") < report.indexOf("Capacidades pendientes"));
	} finally { fixture.dispose(); }
});

test("malformed configuration is rejected instead of guessing a hook contract", () => {
	const fixture = createClaudeFixture();
	try {
		const path = join(fixture.configHome, "claude-compat.json");
		assert.deepEqual(loadClaudeCompatConfig(fixture.configHome).hooks, []);
		for (const config of [
			{ schema: "other" },
			{ schema: CLAUDE_COMPAT_CONFIG_SCHEMA, hooks: [{ id: "a", plugin: "p", script: "../escape.sh", event: "PreToolUse" }] },
			{ schema: CLAUDE_COMPAT_CONFIG_SCHEMA, hooks: [{ id: "a", plugin: "p", script: "a.sh", event: "Stop" }] },
			{ schema: CLAUDE_COMPAT_CONFIG_SCHEMA, hooks: [{ id: "a", plugin: "p", script: "a.sh", event: "PreToolUse" }, { id: "a", plugin: "p", script: "b.sh", event: "PreToolUse" }] },
		]) {
			writeFileSync(path, JSON.stringify(config));
			assert.throws(() => loadClaudeCompatConfig(fixture.configHome), /claude-compat:loadClaudeCompatConfig failed/);
		}
		writeFileSync(path, JSON.stringify({ schema: CLAUDE_COMPAT_CONFIG_SCHEMA, nativeEquivalents: { engram: "", memo: "native memo" } }));
		assert.deepEqual(loadClaudeCompatConfig(fixture.configHome).nativeEquivalents, { memo: "native memo" });
	} finally { fixture.dispose(); }
});

test("sync writes only derived state under the Pi agent home and leaves Claude Code configuration untouched", () => {
	const fixture = createClaudeFixture();
	try {
		fixture.plugin({ key: "sample@market", version: "1.0.0", files: { "skills/report/SKILL.md": skillFile("report") } });
		fixture.finalize();
		const settings = readFileSync(join(fixture.home, ".claude", "settings.json"), "utf8");
		sync(fixture);
		assert.equal(readFileSync(join(fixture.home, ".claude", "settings.json"), "utf8"), settings);
		assert.equal(existsSync(join(fixture.agentHome, "settings.json")), false, "Pi settings are not rewritten");
		assert.equal(JSON.parse(readFileSync(claudeCompatStatePath(fixture.agentHome), "utf8")).schema, "gentle-pi.claude-compat-state/v1");
	} finally { fixture.dispose(); }
});
