import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Type } from "typebox";
import { createClaudeCompatExtension } from "../extensions/claude-compat.ts";
import { createMemoryWriteGuardExtension } from "../extensions/memory-write-guard.ts";
import { createSessionContextExtension } from "../extensions/session-context.ts";
import { createSessionSignalsExtension } from "../extensions/session-signals.ts";
import { MEMORY_WRITE_GUARD, SESSION_CONTEXT, SESSION_SIGNALS, type SessionSignalEvent } from "../lib/integrations/constants.ts";
import { startOfflinePiSession } from "./support/offline-pi-session.ts";

const FOREIGN_WRITE = "mcp__memory__mem_save";

function workspace() {
	const root = mkdtempSync(join(tmpdir(), "integrations-"));
	const paths = { root, cwd: join(root, "project"), agentDir: join(root, "agent"), configHome: join(root, "config"), home: join(root, "home") };
	for (const path of [paths.cwd, paths.agentDir, paths.configHome, paths.home]) mkdirSync(path, { recursive: true });
	return { ...paths, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

async function everyIntegration(paths: ReturnType<typeof workspace>, onSettled?: (event: SessionSignalEvent, error?: Error) => void) {
	const foreignMemory = (pi: Parameters<ReturnType<typeof createSessionContextExtension>>[0]) => {
		pi.registerTool({ name: FOREIGN_WRITE, label: FOREIGN_WRITE, description: "Synthetic foreign write", parameters: Type.Object({}, { additionalProperties: true }), async execute() { return { content: [{ type: "text", text: "saved" }], details: {} }; } });
	};
	const opened = await startOfflinePiSession({ cwd: paths.cwd, agentDir: paths.agentDir, tools: ["read", FOREIGN_WRITE], plans: [[{ name: FOREIGN_WRITE, arguments: {} }]], extensionFactories: [
		foreignMemory,
		createClaudeCompatExtension({ env: {}, home: paths.home, agentHome: paths.agentDir, configHome: paths.configHome }),
		createSessionContextExtension({ env: {}, home: paths.home, configHome: paths.configHome }),
		createSessionSignalsExtension({ env: {}, home: paths.home, configHome: paths.configHome, onSettled }),
		createMemoryWriteGuardExtension({ env: {}, configHome: paths.configHome }),
	] });
	return opened;
}

test("every integration loaded together stays inert without configuration and the import keeps working", async () => {
	const paths = workspace();
	try {
		const { session, sessionManager, results, notices } = await everyIntegration(paths);
		try {
			await session.prompt("Hola.");
			assert.equal(results[0].isError, false, "no integration blocks tools when unconfigured");
			assert.equal(sessionManager.getBranch().some((entry) => entry.type === "custom_message"), false, "no context is injected");
			assert.deepEqual(notices, []);
		} finally { session.dispose(); }
	} finally { paths.dispose(); }
});

test("configuring one integration does not activate the others, and a broken one does not affect them", async () => {
	const paths = workspace();
	const received: string[] = [];
	const server = createServer((request, response) => { request.on("data", (chunk) => received.push(String(chunk))); request.on("end", () => { response.statusCode = 204; response.end(); }); });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		writeFileSync(join(paths.configHome, SESSION_CONTEXT.CONFIG_FILE), JSON.stringify({ schema: SESSION_CONTEXT.CONFIG_SCHEMA, entries: [{ id: "caveman", text: "Modo cavernícola." }] }));
		const onlyContext = await everyIntegration(paths);
		try {
			await onlyContext.session.prompt("Hola.");
			assert.equal(onlyContext.results[0].isError, false, "the memory guard stays inactive");
			assert.equal(received.length, 0, "no signal is sent");
			assert.ok(onlyContext.sessionManager.getBranch().some((entry) => entry.type === "custom_message" && entry.customType === SESSION_CONTEXT.MESSAGE_TYPE));
		} finally { onlyContext.session.dispose(); }

		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/signal`;
		writeFileSync(join(paths.configHome, SESSION_SIGNALS.CONFIG_FILE), JSON.stringify({ schema: SESSION_SIGNALS.CONFIG_SCHEMA, events: ["activity_end"], target: { type: "http", url } }));
		writeFileSync(join(paths.configHome, MEMORY_WRITE_GUARD.CONFIG_FILE), "{ broken");
		let settle!: () => void;
		const delivered = new Promise<void>((resolve) => { settle = resolve; });
		const mixed = await everyIntegration(paths, () => settle());
		try {
			await mixed.session.prompt("Hola.");
			await delivered;
			assert.equal(received.length, 1, "signals keep working next to a broken guard configuration");
			assert.equal(mixed.results[0].isError, false);
			assert.ok(mixed.sessionManager.getBranch().some((entry) => entry.type === "custom_message" && entry.customType === SESSION_CONTEXT.MESSAGE_TYPE), "context keeps working");
			assert.deepEqual(mixed.notices.map((notice) => notice.text.split(":")[0]), ["memory-write-guard"], "only the broken integration reports");
		} finally { mixed.session.dispose(); }
	} finally { server.close(); paths.dispose(); }
});
