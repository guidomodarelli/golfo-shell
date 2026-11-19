import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createClaudeCompatExtension } from "../extensions/claude-compat.ts";
import { REQUESTED_TOOLS_ENV } from "../lib/agents-runner.ts";
import { assertRestrictedCommand, parseCommandPattern, PolicyViolation } from "../lib/claude-compat/agent-policy.ts";
import { synchronizeClaudeCompat } from "../lib/claude-compat/sync.ts";
import { agentFile, createClaudeFixture } from "./claude-compat-fixtures.ts";
import { startOfflinePiSession } from "./support/offline-pi-session.ts";

const SCRIPT = "#!/usr/bin/env bash\necho \"ran:$#:$*\"\n";
const EXECUTABLE_MODE = 0o755;

function portable(path: string): string {
	return path.replaceAll("\\", "/");
}

function pluginWithScript(fixture: ReturnType<typeof createClaudeFixture>, tools: string): string {
	const root = fixture.plugin({ key: "runner@market", version: "1.0.0", files: {
		"agents/runner.md": agentFile({ name: "runner", description: "Runs the plugin script", tools }, "Run ${CLAUDE_PLUGIN_ROOT}/scripts/run.sh with the requested target."),
		"scripts/run.sh": SCRIPT,
	} });
	chmodSync(join(root, "scripts", "run.sh"), EXECUTABLE_MODE);
	fixture.finalize();
	return root;
}

test("Bash(${CLAUDE_PLUGIN_ROOT}/script *) grants exactly that plugin script in a real Pi child, with literal arguments", async () => {
	const fixture = createClaudeFixture();
	try {
		const root = pluginWithScript(fixture, "Read, Bash(${CLAUDE_PLUGIN_ROOT}/scripts/run.sh *)");
		const state = synchronizeClaudeCompat({ home: fixture.home, agentHome: fixture.agentHome, configHome: fixture.configHome, nativeSkillDirectories: [] });
		const [policy] = state.policies;
		const script = portable(join(root, "scripts", "run.sh"));
		assert.deepEqual(policy.unsupported, []);
		assert.deepEqual(policy.commandPatterns[0].words, [script]);
		const instructions = readFileSync(state.agents[0].file, "utf8");
		assert.ok(instructions.includes(`Bash está restringido a: Bash(${script} *)`), "the child is told the resolved script it may run");
		assert.ok(instructions.includes(`Run ${portable(root)}/scripts/run.sh`), "the body names the same path the grant accepts");
		const env = { GENTLE_PI_AGENTS_CHILD: "1", [REQUESTED_TOOLS_ENV]: policy.tools.join(",") };
		const { session, results } = await startOfflinePiSession({ cwd: fixture.root, agentDir: fixture.agentHome, tools: ["read", "bash"], extensionFactories: [createClaudeCompatExtension({ env, home: fixture.home, agentHome: fixture.agentHome, configHome: fixture.configHome })], plans: [[
			{ name: "bash", arguments: { command: `${script} staging --dry-run` } },
			{ name: "bash", arguments: { command: `${script} "two words"` } },
			{ name: "bash", arguments: { command: `${script} x; rm -rf data` } },
			{ name: "bash", arguments: { command: `${portable(root)}/scripts/../scripts/run.sh x` } },
			{ name: "bash", arguments: { command: "git status" } },
		]] });
		try {
			await session.prompt("Deploy.");
			const byId = Object.fromEntries(results.map((result) => [result.id, result]));
			assert.equal(byId["bash-0"].isError, false, byId["bash-0"].text);
			assert.match(byId["bash-0"].text, /ran:2:staging --dry-run/);
			assert.match(byId["bash-1"].text, /claude-compat: orden restringida rechazada/, "quoted arguments are refused, never reinterpreted");
			assert.match(byId["bash-2"].text, /claude-compat: orden restringida rechazada/);
			assert.match(byId["bash-3"].text, /claude-compat: comando fuera de la allowlist/, "another spelling of the path is not the granted script");
			assert.match(byId["bash-4"].text, /claude-compat: comando fuera de la allowlist/, "the grant does not widen to other commands");
		} finally { session.dispose(); }
	} finally { fixture.dispose(); }
});

test("plugin script patterns that escape the plugin root, do not exist or come from user agents stay unsupported", () => {
	const fixture = createClaudeFixture();
	try {
		const root = pluginWithScript(fixture, "Read, Bash(${CLAUDE_PLUGIN_ROOT}/../outside.sh), Bash(${CLAUDE_PLUGIN_ROOT}/scripts/missing.sh), Bash($CLAUDE_PLUGIN_ROOT/scripts/run.sh)");
		fixture.write("home/.claude/agents/local.md", agentFile({ name: "local", description: "User agent", tools: "Bash(${CLAUDE_PLUGIN_ROOT}/scripts/run.sh)" }));
		writeFileSync(join(root, "..", "outside.sh"), SCRIPT);
		const state = synchronizeClaudeCompat({ home: fixture.home, agentHome: fixture.agentHome, configHome: fixture.configHome, nativeSkillDirectories: [] });
		const runner = state.policies.find((policy) => policy.name === "claude-runner-runner")!;
		assert.deepEqual(runner.unsupported, ["Bash(${CLAUDE_PLUGIN_ROOT}/../outside.sh)", "Bash(${CLAUDE_PLUGIN_ROOT}/scripts/missing.sh)"]);
		assert.deepEqual(runner.commandPatterns.map((pattern) => pattern.words), [[portable(join(root, "scripts", "run.sh"))]], "the $CLAUDE_PLUGIN_ROOT spelling is accepted too");
		const local = state.policies.find((policy) => policy.name === "claude-user-local")!;
		assert.deepEqual(local.unsupported, ["Bash(${CLAUDE_PLUGIN_ROOT}/scripts/run.sh)"], "user agents have no plugin root to resolve");
	} finally { fixture.dispose(); }
});

/** Directory link that needs no privileges: a junction on Windows, a symlink elsewhere. */
const DIRECTORY_LINK_TYPE = process.platform === "win32" ? "junction" : "dir";

test("a plugin script whose directory is relinked outside the root after the import is refused on the next call", () => {
	const fixture = createClaudeFixture();
	try {
		const root = pluginWithScript(fixture, "Bash(${CLAUDE_PLUGIN_ROOT}/scripts/run.sh)");
		const pattern = parseCommandPattern("${CLAUDE_PLUGIN_ROOT}/scripts/run.sh", root)!;
		const script = portable(join(root, "scripts", "run.sh"));
		assert.deepEqual(assertRestrictedCommand(script, [pattern]), [script]);
		const outside = join(fixture.root, "outside");
		fixture.write("outside/run.sh", SCRIPT);
		rmSync(join(root, "scripts"), { recursive: true });
		symlinkSync(outside, join(root, "scripts"), DIRECTORY_LINK_TYPE);
		assert.throws(() => assertRestrictedCommand(script, [pattern]), (error: unknown) => error instanceof PolicyViolation && /script fuera de la raíz autorizada/.test(error.message));
		assert.equal(parseCommandPattern("${CLAUDE_PLUGIN_ROOT}/scripts/run.sh", root), undefined, "a new import refuses it too");
	} finally { fixture.dispose(); }
});

test("a plugin script that is no longer a regular file is refused", () => {
	const fixture = createClaudeFixture();
	try {
		const root = pluginWithScript(fixture, "Bash(${CLAUDE_PLUGIN_ROOT}/scripts/run.sh)");
		const pattern = parseCommandPattern("${CLAUDE_PLUGIN_ROOT}/scripts/run.sh", root)!;
		const script = portable(join(root, "scripts", "run.sh"));
		rmSync(join(root, "scripts", "run.sh"));
		assert.throws(() => assertRestrictedCommand(script, [pattern]), PolicyViolation, "a deleted script is refused");
		mkdirSync(join(root, "scripts", "run.sh"));
		assert.throws(() => assertRestrictedCommand(script, [pattern]), PolicyViolation, "a directory is not a script");
	} finally { fixture.dispose(); }
});
