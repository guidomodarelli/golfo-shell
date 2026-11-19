import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { createSessionContextExtension } from "../extensions/session-context.ts";
import { SESSION_CONTEXT } from "../lib/integrations/constants.ts";
import { loadSessionContextConfig } from "../lib/integrations/session-context.ts";
import { startOfflinePiSession } from "./support/offline-pi-session.ts";

function workspace() {
	const root = mkdtempSync(join(tmpdir(), "session-context-"));
	const paths = { root, cwd: join(root, "project"), agentDir: join(root, "agent"), configHome: join(root, "config"), home: join(root, "home") };
	for (const path of [paths.cwd, paths.agentDir, paths.configHome, paths.home]) mkdirSync(path, { recursive: true });
	return { ...paths, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

function writeConfig(configHome: string, config: Record<string, unknown>): void {
	writeFileSync(join(configHome, SESSION_CONTEXT.CONFIG_FILE), JSON.stringify({ schema: SESSION_CONTEXT.CONFIG_SCHEMA, ...config }));
}

function deliveredBlocks(branch: readonly SessionEntry[]): string[] {
	return branch.filter((entry) => entry.type === "custom_message" && entry.customType === SESSION_CONTEXT.MESSAGE_TYPE).map((entry) => String((entry as { content: unknown }).content));
}

async function open(paths: ReturnType<typeof workspace>, env: NodeJS.ProcessEnv = {}) {
	return startOfflinePiSession({ cwd: paths.cwd, agentDir: paths.agentDir, extensionFactories: [createSessionContextExtension({ env, home: paths.home, configHome: paths.configHome })] });
}

test("without session-context.json nothing is injected and nothing is reported", async () => {
	const paths = workspace();
	try {
		const { session, sessionManager, notices, requests } = await open(paths);
		try {
			await session.prompt("Hola.");
			assert.deepEqual(deliveredBlocks(sessionManager.getBranch()), []);
			assert.deepEqual(notices, []);
			assert.equal(requests.length, 1);
		} finally { session.dispose(); }
	} finally { paths.dispose(); }
});

test("configured text and files reach the model once per cycle as hidden context, never executed", async () => {
	const paths = workspace();
	try {
		writeFileSync(join(paths.home, "terse.md"), "Respond tersely, like a caveman.");
		writeConfig(paths.configHome, { entries: [
			{ id: "caveman", file: "~/terse.md" },
			{ id: "rules", text: "Regla sintética: citar archivos con ruta relativa.", on: ["startup"] },
			{ id: "after-compact", text: "Solo tras compactar.", on: ["compact"] },
		] });
		const { session, sessionManager, requests } = await open(paths);
		try {
			await session.prompt("Primera.");
			await session.prompt("Segunda.");
			const blocks = deliveredBlocks(sessionManager.getBranch());
			assert.equal(blocks.length, 1, "one hidden message per cycle");
			assert.equal(blocks[0], "Respond tersely, like a caveman.\n\nRegla sintética: citar archivos con ruta relativa.");
			assert.ok(requests[0].some((text) => text.includes("like a caveman")), "the model receives the context on the first turn");
			const hidden = sessionManager.getBranch().find((entry) => entry.type === "custom_message") as { display: boolean };
			assert.equal(hidden.display, false);

			await session.reload();
			await session.prompt("Tras recargar.");
			assert.equal(deliveredBlocks(sessionManager.getBranch()).length, 1, "a reload does not repeat context already in the cycle");
		} finally { session.dispose(); }
	} finally { paths.dispose(); }
});

test("compaction opens a new cycle: entries for compact are delivered again, startup-only ones are not", async () => {
	const paths = workspace();
	try {
		writeConfig(paths.configHome, { entries: [
			{ id: "caveman", text: "Modo cavernícola." },
			{ id: "startup-only", text: "Solo al iniciar.", on: ["startup"] },
		] });
		const { session, sessionManager } = await open(paths);
		try {
			await session.prompt("Primera.");
			await session.prompt("Segunda.");
			await session.compact();
			await session.prompt("Tras compactar.");
			assert.deepEqual(deliveredBlocks(sessionManager.getBranch()), ["Modo cavernícola.\n\nSolo al iniciar.", "Modo cavernícola."]);
		} finally { session.dispose(); }
	} finally { paths.dispose(); }
});

test("/session-context off keeps the context out after compaction and reload until /session-context on", async () => {
	const paths = workspace();
	try {
		writeConfig(paths.configHome, { entries: [{ id: "caveman", text: "Modo cavernícola." }, { id: "rules", text: "Reglas." }] });
		const { session, sessionManager, notices } = await open(paths);
		try {
			await session.prompt("/session-context off caveman");
			await session.prompt("Primera.");
			assert.deepEqual(deliveredBlocks(sessionManager.getBranch()), ["Reglas."], "a pending entry switched off is withdrawn before delivery");
			await session.prompt("/session-context off");
			await session.compact();
			await session.reload();
			await session.prompt("Tras compactar y recargar.");
			assert.deepEqual(deliveredBlocks(sessionManager.getBranch()), ["Reglas."], "the switch-off survives compaction and reload");
			await session.prompt("/session-context on");
			await session.prompt("Reactivado.");
			assert.deepEqual(deliveredBlocks(sessionManager.getBranch()), ["Reglas.", "Modo cavernícola.\n\nReglas."]);
			assert.ok(notices.some((notice) => /caveman desactivado en esta sesión/.test(notice.text)));
		} finally { session.dispose(); }
	} finally { paths.dispose(); }
});

test("/session-context on <id> after a global off restores only that entry, also after compaction and reload", async () => {
	const paths = workspace();
	try {
		writeConfig(paths.configHome, { entries: [{ id: "caveman", text: "Modo cavernícola." }, { id: "rules", text: "Reglas." }] });
		const { session, sessionManager } = await open(paths);
		try {
			await session.prompt("/session-context off");
			await session.prompt("/session-context on caveman");
			await session.prompt("Primera.");
			assert.deepEqual(deliveredBlocks(sessionManager.getBranch()), ["Modo cavernícola."], "the re-enabled entry is delivered and the rest stay off");
			await session.compact();
			await session.reload();
			await session.prompt("Tras compactar y recargar.");
			assert.deepEqual(deliveredBlocks(sessionManager.getBranch()), ["Modo cavernícola.", "Modo cavernícola."], "the per-entry override survives compaction and reload");
			await session.prompt("/session-context off");
			await session.prompt("/session-context on");
			await session.prompt("Todo reactivado.");
			assert.deepEqual(deliveredBlocks(sessionManager.getBranch()).at(-1), "Reglas.", "a global toggle resets the per-entry overrides before it");
		} finally { session.dispose(); }
	} finally { paths.dispose(); }
});

test("context owed by a compaction is still delivered when the session reloads before the next prompt", async () => {
	const paths = workspace();
	try {
		writeConfig(paths.configHome, { entries: [{ id: "after-compact", text: "Solo tras compactar.", on: ["compact"] }] });
		const { session, sessionManager } = await open(paths);
		try {
			await session.prompt("Primera.");
			await session.prompt("Segunda.");
			assert.deepEqual(deliveredBlocks(sessionManager.getBranch()), []);
			await session.compact();
			await session.reload();
			await session.prompt("Tras compactar y recargar.");
			assert.deepEqual(deliveredBlocks(sessionManager.getBranch()), ["Solo tras compactar."]);
			await session.reload();
			await session.prompt("Otra recarga.");
			assert.deepEqual(deliveredBlocks(sessionManager.getBranch()), ["Solo tras compactar."], "a later reload in the same cycle does not repeat it");
		} finally { session.dispose(); }
	} finally { paths.dispose(); }
});

test("enabled: false, children and invalid configuration inject nothing; invalid files are reported with their path", async () => {
	const paths = workspace();
	try {
		writeConfig(paths.configHome, { enabled: false, entries: [{ id: "caveman", text: "Modo cavernícola." }] });
		const disabled = await open(paths);
		try {
			await disabled.session.prompt("Hola.");
			assert.deepEqual(deliveredBlocks(disabled.sessionManager.getBranch()), []);
		} finally { disabled.session.dispose(); }

		writeConfig(paths.configHome, { entries: [{ id: "caveman", text: "Modo cavernícola." }] });
		const child = await open(paths, { GENTLE_PI_AGENTS_CHILD: "1" });
		try {
			await child.session.prompt("Hola.");
			assert.deepEqual(deliveredBlocks(child.sessionManager.getBranch()), [], "children are excluded unless includeChildren is set");
		} finally { child.session.dispose(); }

		writeConfig(paths.configHome, { entries: [{ id: "caveman", text: "a", file: "x.md" }] });
		const broken = await open(paths);
		try {
			await broken.session.prompt("Hola.");
			assert.deepEqual(deliveredBlocks(broken.sessionManager.getBranch()), []);
			assert.match(broken.notices.map((notice) => notice.text).join("\n"), /session-context: entries\[0\] debe declarar exactamente uno de text o file[\s\S]*session-context\.json/);
		} finally { broken.session.dispose(); }
	} finally { paths.dispose(); }
});

test("configuration contract rejects ambiguous, oversized or unknown entries instead of guessing", () => {
	const paths = workspace();
	try {
		const invalid: Array<[Record<string, unknown>, RegExp]> = [
			[{ entries: {} }, /entries debe ser una lista/],
			[{ entries: [{ id: "Bad Id", text: "x" }] }, /id debe ser único/],
			[{ entries: [{ id: "a", text: "x" }, { id: "a", text: "y" }] }, /id debe ser único/],
			[{ entries: [{ id: "a", text: "x", on: ["reload"] }] }, /on debe ser una lista no vacía/],
			[{ entries: [{ id: "a", text: "x".repeat(SESSION_CONTEXT.MAX_ENTRY_BYTES + 1) }] }, /se rechaza en vez de recortarse/],
			[{ entries: [{ id: "a", file: "missing.md" }] }, /no se pudo leer/],
			[{ enabled: "yes", entries: [] }, /enabled debe ser true o false/],
		];
		for (const [config, expected] of invalid) {
			writeConfig(paths.configHome, config);
			assert.throws(() => loadSessionContextConfig(paths.configHome, paths.home), expected, JSON.stringify(config).slice(0, 80));
		}
		writeFileSync(join(paths.configHome, SESSION_CONTEXT.CONFIG_FILE), JSON.stringify({ schema: "other/v1", entries: [] }));
		assert.throws(() => loadSessionContextConfig(paths.configHome, paths.home), /debe declarar "schema"/);
		writeConfig(paths.configHome, { entries: [{ id: "off", text: "x", enabled: false }] });
		assert.deepEqual(loadSessionContextConfig(paths.configHome, paths.home)?.entries, [], "a disabled entry is not loaded");
	} finally { paths.dispose(); }
});
