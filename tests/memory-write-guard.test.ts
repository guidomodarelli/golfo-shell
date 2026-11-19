import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionFactory, ToolInfo } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createMemoryWriteGuardExtension } from "../extensions/memory-write-guard.ts";
import { MEMORY_WRITE_GUARD } from "../lib/integrations/constants.ts";
import { activateMemoryWriteGuard, isProtectedWrite, loadMemoryWriteGuardConfig, type MemoryWriteGuardConfig, missingNativeAlternative } from "../lib/integrations/memory-write-guard.ts";
import { type PlannedToolCall, startOfflinePiSession } from "./support/offline-pi-session.ts";

/** Pi name of the foreign provider's write, as Pi normalizes the Claude Code server `plugin-memory`. */
const FOREIGN_WRITE = "mcp__plugin_memory__mem_save";
const FOREIGN_READ = "mcp__plugin_memory__mem_search";
const NATIVE_WRITE = "mem_save";
/** Source Pi assigns to tools of extensions passed inline to the loader. */
const INLINE_SOURCE = "inline";

function workspace() {
	const root = mkdtempSync(join(tmpdir(), "memory-write-guard-"));
	const paths = { root, cwd: join(root, "project"), agentDir: join(root, "agent"), configHome: join(root, "config") };
	for (const path of [paths.cwd, paths.agentDir, paths.configHome]) mkdirSync(path, { recursive: true });
	return { ...paths, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

function writeConfig(configHome: string, config: Record<string, unknown>): void {
	writeFileSync(join(configHome, MEMORY_WRITE_GUARD.CONFIG_FILE), JSON.stringify({ schema: MEMORY_WRITE_GUARD.CONFIG_SCHEMA, ...config }));
}

/** Synthetic memory providers: each tool answers with its own name. */
function memoryProviders(): ExtensionFactory {
	return (pi) => {
		for (const name of [NATIVE_WRITE, FOREIGN_WRITE, FOREIGN_READ]) {
			pi.registerTool({ name, label: name, description: `Synthetic ${name}`, parameters: Type.Object({}, { additionalProperties: true }), async execute() { return { content: [{ type: "text", text: `${name} ok` }], details: {} }; } });
		}
	};
}

const CALLS: PlannedToolCall[] = [
	{ name: FOREIGN_WRITE, arguments: { title: "x" } },
	{ name: FOREIGN_READ, arguments: { query: "x" } },
	{ name: NATIVE_WRITE, arguments: { title: "x" } },
];

async function run(paths: ReturnType<typeof workspace>, tools: string[] = ["read", NATIVE_WRITE, FOREIGN_WRITE, FOREIGN_READ]) {
	const opened = await startOfflinePiSession({ cwd: paths.cwd, agentDir: paths.agentDir, tools, plans: [CALLS.filter((call) => tools.includes(call.name))], extensionFactories: [memoryProviders(), createMemoryWriteGuardExtension({ env: {}, configHome: paths.configHome })] });
	try {
		await opened.session.prompt("Guardar memoria.");
	} finally { opened.session.dispose(); }
	const byTool = Object.fromEntries(opened.results.map((result) => [result.id.replace(/-\d+$/, ""), result]));
	return { byTool, notices: opened.notices };
}

const ACTIVE_CONFIG = { protectedTools: ["mcp__plugin-memory__mem_save"], nativeAlternative: { tools: [NATIVE_WRITE], source: INLINE_SOURCE } };

test("without memory-write-guard.json every memory tool runs untouched", async () => {
	const paths = workspace();
	try {
		const { byTool, notices } = await run(paths);
		assert.equal(byTool[FOREIGN_WRITE].isError, false);
		assert.match(byTool[FOREIGN_WRITE].text, /mem_save ok/);
		assert.deepEqual(notices, []);
	} finally { paths.dispose(); }
});

test("an active guard refuses only the protected write, pointing to the native tool; reads and native writes run", async () => {
	const paths = workspace();
	try {
		writeConfig(paths.configHome, ACTIVE_CONFIG);
		const { byTool, notices } = await run(paths);
		assert.equal(byTool[FOREIGN_WRITE].isError, true);
		assert.match(byTool[FOREIGN_WRITE].text, /memory-write-guard: mcp__plugin_memory__mem_save está protegida; escribir la memoria con la herramienta nativa \(mem_save\)/);
		assert.equal(byTool[FOREIGN_READ].isError, false, "reads of the other provider are never touched");
		assert.equal(byTool[NATIVE_WRITE].isError, false);
		assert.deepEqual(notices, []);
	} finally { paths.dispose(); }
});

test("activation without a working native route is rejected explicitly and blocks nothing", async () => {
	const paths = workspace();
	try {
		writeConfig(paths.configHome, ACTIVE_CONFIG);
		const withoutNative = await run(paths, ["read", FOREIGN_WRITE, FOREIGN_READ]);
		assert.equal(withoutNative.byTool[FOREIGN_WRITE].isError, false, "with no native route, MCP writes keep working");
		assert.match(withoutNative.notices.map((notice) => notice.text).join("\n"), /memory-write-guard: activación rechazada: la herramienta nativa mem_save no está cargada; sin una ruta nativa para escribir memoria la protección no se activa/);

		writeConfig(paths.configHome, { ...ACTIVE_CONFIG, nativeAlternative: { tools: [NATIVE_WRITE], source: "npm:gentle-engram" } });
		const foreignSource = await run(paths);
		assert.equal(foreignSource.byTool[FOREIGN_WRITE].isError, false);
		assert.match(foreignSource.notices.map((notice) => notice.text).join("\n"), /mem_save no proviene de npm:gentle-engram/);
	} finally { paths.dispose(); }
});

test("enabled: false and an invalid file leave the guard inactive; the invalid file is reported as an error", async () => {
	const paths = workspace();
	try {
		writeConfig(paths.configHome, { ...ACTIVE_CONFIG, enabled: false });
		const disabled = await run(paths);
		assert.equal(disabled.byTool[FOREIGN_WRITE].isError, false);
		assert.deepEqual(disabled.notices, []);

		writeConfig(paths.configHome, { protectedTools: [], nativeAlternative: { tools: [NATIVE_WRITE] } });
		const broken = await run(paths);
		assert.equal(broken.byTool[FOREIGN_WRITE].isError, false);
		assert.deepEqual(broken.notices.map((notice) => notice.level), ["error"]);
		assert.match(broken.notices[0].text, /memory-write-guard: protectedTools debe ser una lista no vacía[\s\S]*no está activa/);
	} finally { paths.dispose(); }
});

function tool(name: string, source = INLINE_SOURCE): ToolInfo {
	return { name, description: name, parameters: {}, sourceInfo: { path: `<${name}>`, source, scope: "temporary", origin: "top-level" } } as unknown as ToolInfo;
}

test("an active guard whose native route later fails keeps the protected writes blocked with an actionable reason", () => {
	const config: MemoryWriteGuardConfig = { enabled: true, protectedTools: [FOREIGN_WRITE], nativeAlternative: { tools: [NATIVE_WRITE], source: "npm:gentle-engram" } };
	const activation = activateMemoryWriteGuard(config, [tool(NATIVE_WRITE, "npm:gentle-engram@1.4.0"), tool(FOREIGN_WRITE)]);
	assert.equal(activation.status, "active", "a versioned package source matches its name");
	assert.equal(missingNativeAlternative(config.nativeAlternative, [tool(NATIVE_WRITE, "npm:gentle-engram-fork")]), "la herramienta nativa mem_save no proviene de npm:gentle-engram");
	assert.equal(missingNativeAlternative(config.nativeAlternative, []), "la herramienta nativa mem_save no está cargada");
	assert.match(missingNativeAlternative(config.nativeAlternative, [tool(NATIVE_WRITE, "npm:gentle-engram"), tool(NATIVE_WRITE, "npm:gentle-engram")])!, /registrada 2 veces/);
	assert.equal(isProtectedWrite(config, FOREIGN_WRITE), true);
	assert.equal(isProtectedWrite(config, FOREIGN_READ), false);
	assert.equal(isProtectedWrite(config, NATIVE_WRITE), false);
});

test("configuration contract rejects lists it cannot apply exactly", () => {
	const paths = workspace();
	try {
		const invalid: Array<[Record<string, unknown>, RegExp]> = [
			[{ protectedTools: ["x"] }, /nativeAlternative debe ser un objeto/],
			[{ protectedTools: ["x"], nativeAlternative: { tools: [] } }, /nativeAlternative\.tools debe ser una lista no vacía/],
			[{ protectedTools: ["mcp__memory__*"], nativeAlternative: { tools: ["mem_save"] } }, /protectedTools debe ser una lista no vacía de nombres/],
			[{ protectedTools: ["mem_save"], nativeAlternative: { tools: ["mem_save"] } }, /a la vez protegida y alternativa nativa/],
			[{ protectedTools: ["x"], nativeAlternative: { tools: ["mem_save"], source: "" } }, /source debe ser un string no vacío/],
		];
		for (const [config, expected] of invalid) {
			writeConfig(paths.configHome, config);
			assert.throws(() => loadMemoryWriteGuardConfig(paths.configHome), expected, JSON.stringify(config));
		}
	} finally { paths.dispose(); }
});
