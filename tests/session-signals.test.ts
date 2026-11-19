import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSessionSignalsExtension } from "../extensions/session-signals.ts";
import { SESSION_SIGNALS, type SessionSignalEvent } from "../lib/integrations/constants.ts";
import { loadSessionSignalsConfig } from "../lib/integrations/session-signals.ts";
import { startOfflinePiSession } from "./support/offline-pi-session.ts";

const EXPECTED_PAYLOAD_KEYS = ["event", "schema", "sessionId", "timestamp"];
const NO_REQUESTS = 0;

function workspace() {
	const root = mkdtempSync(join(tmpdir(), "session-signals-"));
	const paths = { root, cwd: join(root, "project"), agentDir: join(root, "agent"), configHome: join(root, "config") };
	for (const path of [paths.cwd, paths.agentDir, paths.configHome]) mkdirSync(path, { recursive: true });
	return { ...paths, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

function writeConfig(configHome: string, config: Record<string, unknown>): void {
	writeFileSync(join(configHome, SESSION_SIGNALS.CONFIG_FILE), JSON.stringify({ schema: SESSION_SIGNALS.CONFIG_SCHEMA, ...config }));
}

/** Resolves after `count` deliveries settle, with each outcome. */
function settlements(count: number) {
	const outcomes: Array<{ event: SessionSignalEvent; error?: Error }> = [];
	let resolveAll!: () => void;
	const done = new Promise<void>((resolve) => { resolveAll = resolve; });
	const onSettled = (event: SessionSignalEvent, error?: Error) => {
		outcomes.push({ event, ...(error ? { error } : {}) });
		if (outcomes.length === count) resolveAll();
	};
	return { outcomes, done, onSettled };
}

async function listen(handler: (request: IncomingMessage, body: string, respond: (status: number) => void) => void): Promise<{ server: Server; url: string }> {
	const server = createServer((request, response) => {
		let body = "";
		request.on("data", (chunk) => { body += chunk; });
		request.on("end", () => handler(request, body, (status) => { response.statusCode = status; response.end(); }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/signal` };
}

test("without session-signals.json no signal is sent and nothing is reported", async () => {
	const paths = workspace();
	const received: string[] = [];
	const { server, url } = await listen((_request, body, respond) => { received.push(body); respond(204); });
	try {
		const { session, notices } = await startOfflinePiSession({ cwd: paths.cwd, agentDir: paths.agentDir, extensionFactories: [createSessionSignalsExtension({ env: {}, configHome: paths.configHome })] });
		try {
			await session.prompt("Hola.");
			assert.equal(received.length, NO_REQUESTS, `nothing reaches ${url}`);
			assert.deepEqual(notices, []);
		} finally { session.dispose(); }
	} finally { server.close(); paths.dispose(); }
});

test("an HTTP target receives turn_start and activity_end in order with only the documented payload", async () => {
	const paths = workspace();
	const received: Array<Record<string, unknown>> = [];
	const { server, url } = await listen((_request, body, respond) => { received.push(JSON.parse(body)); respond(204); });
	try {
		writeConfig(paths.configHome, { target: { type: "http", url } });
		const settled = settlements(2);
		const { session, sessionManager, notices } = await startOfflinePiSession({ cwd: paths.cwd, agentDir: paths.agentDir, extensionFactories: [createSessionSignalsExtension({ env: { SECRET_TOKEN: "do-not-send" }, configHome: paths.configHome, onSettled: settled.onSettled })] });
		try {
			await session.prompt("Hola, esto no debe salir del proceso.");
			await settled.done;
			assert.deepEqual(received.map((payload) => payload.event), ["turn_start", "activity_end"]);
			for (const payload of received) {
				assert.deepEqual(Object.keys(payload).sort(), EXPECTED_PAYLOAD_KEYS);
				assert.equal(payload.schema, SESSION_SIGNALS.PAYLOAD_SCHEMA);
				assert.equal(payload.sessionId, sessionManager.getSessionId());
				assert.ok(!Number.isNaN(Date.parse(String(payload.timestamp))));
			}
			assert.doesNotMatch(JSON.stringify(received), /no debe salir|do-not-send|done/, "no prompt, transcript or environment value is sent");
			assert.deepEqual(notices, []);
		} finally { session.dispose(); }
	} finally { server.close(); paths.dispose(); }
});

test("a command target gets the payload on stdin with arguments kept literal and no inherited secrets", async () => {
	const paths = workspace();
	try {
		const output = join(paths.root, "signals.jsonl");
		const script = join(paths.root, "record-signal.mjs");
		writeFileSync(script, `import { appendFileSync } from "node:fs";
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => appendFileSync(process.argv[2], JSON.stringify({ payload: JSON.parse(input), argument: process.argv[3], secret: process.env.SECRET_TOKEN ?? null }) + "\\n"));
`);
		writeConfig(paths.configHome, { events: ["activity_end"], target: { type: "command", command: process.execPath, args: [script, output, "a b; $(whoami) > x"] } });
		const settled = settlements(1);
		const { session } = await startOfflinePiSession({ cwd: paths.cwd, agentDir: paths.agentDir, extensionFactories: [createSessionSignalsExtension({ env: { ...process.env, SECRET_TOKEN: "do-not-send" }, configHome: paths.configHome, onSettled: settled.onSettled })] });
		try {
			await session.prompt("Hola.");
			await settled.done;
			assert.deepEqual(settled.outcomes.map((outcome) => [outcome.event, outcome.error?.message]), [["activity_end", undefined]]);
			const lines = readFileSync(output, "utf8").trim().split("\n").map((line) => JSON.parse(line));
			assert.equal(lines.length, 1, "only the configured event is sent");
			assert.equal(lines[0].payload.event, "activity_end");
			assert.equal(lines[0].argument, "a b; $(whoami) > x", "arguments are passed as one literal argv entry");
			assert.equal(lines[0].secret, null, "the target does not inherit the session environment");
		} finally { session.dispose(); }
	} finally { paths.dispose(); }
});

test("an unreachable, failing or slow target is reported once with context and never blocks the session", async () => {
	const paths = workspace();
	const { server, url } = await listen((request, _body, respond) => {
		if (request.url?.includes("fail")) respond(500);
		// The slow route never answers; the client timeout must end it.
	});
	try {
		writeConfig(paths.configHome, { target: { type: "http", url: `${url}?fail=1` } });
		const failing = settlements(4);
		const first = await startOfflinePiSession({ cwd: paths.cwd, agentDir: paths.agentDir, extensionFactories: [createSessionSignalsExtension({ env: {}, configHome: paths.configHome, onSettled: failing.onSettled })] });
		try {
			await first.session.prompt("Uno.");
			await first.session.prompt("Dos.");
			await failing.done;
			assert.equal(first.results.length, 0);
			const warnings = first.notices.filter((notice) => notice.level === "warning").map((notice) => notice.text);
			assert.deepEqual(warnings.length, 2, "one warning per distinct cause (turn_start and activity_end), not per signal");
			assert.match(warnings[0], /session-signals: no se pudo enviar turn_start a POST http:\/\/127\.0\.0\.1:\d+\/signal\?fail=1 \(HTTP 500\)/);
		} finally { first.session.dispose(); }

		writeConfig(paths.configHome, { events: ["turn_start"], timeoutMs: 150, target: { type: "http", url } });
		const slow = settlements(1);
		const second = await startOfflinePiSession({ cwd: paths.cwd, agentDir: paths.agentDir, extensionFactories: [createSessionSignalsExtension({ env: {}, configHome: paths.configHome, onSettled: slow.onSettled })] });
		try {
			await second.session.prompt("Lento.");
			await slow.done;
			assert.match(slow.outcomes[0].error!.message, /sin respuesta en 150ms/);
		} finally { second.session.dispose(); }

		writeConfig(paths.configHome, { target: { type: "command", command: join(paths.root, "missing-signal-binary") } });
		const missing = settlements(2);
		const third = await startOfflinePiSession({ cwd: paths.cwd, agentDir: paths.agentDir, extensionFactories: [createSessionSignalsExtension({ env: {}, configHome: paths.configHome, onSettled: missing.onSettled })] });
		try {
			await third.session.prompt("Sin binario.");
			await missing.done;
			assert.match(missing.outcomes[0].error!.message, /session-signals: no se pudo enviar turn_start a .*missing-signal-binary/);
		} finally { third.session.dispose(); }
	} finally { server.closeAllConnections(); server.close(); paths.dispose(); }
});

test("shutting the session down cancels an in-flight signal without reporting it as a failure", async () => {
	const paths = workspace();
	const { server, url } = await listen(() => { /* never answers */ });
	let requestClosed!: Promise<void>;
	const requestArrived = new Promise<void>((arrived) => server.on("request", (request: IncomingMessage) => {
		requestClosed = new Promise<void>((closed) => request.socket.once("close", () => closed()));
		arrived();
	}));
	try {
		writeConfig(paths.configHome, { events: ["turn_start"], timeoutMs: SESSION_SIGNALS.MAX_TIMEOUT_MS, target: { type: "http", url } });
		const settled = settlements(1);
		const { session, notices } = await startOfflinePiSession({ cwd: paths.cwd, agentDir: paths.agentDir, extensionFactories: [createSessionSignalsExtension({ env: {}, configHome: paths.configHome, onSettled: settled.onSettled })] });
		try {
			await session.prompt("Hola.");
			await requestArrived;
			await session.reload();
			await settled.done;
			assert.ok(settled.outcomes[0].error, "the delivery ended by cancellation");
			assert.deepEqual(notices.filter((notice) => notice.level === "warning"), [], "a cancellation is not reported as a failed signal");
			await requestClosed;
		} finally { session.dispose(); }
	} finally { server.closeAllConnections(); server.close(); paths.dispose(); }
});

test("configuration contract rejects targets it cannot deliver to safely", () => {
	const paths = workspace();
	try {
		const invalid: Array<[Record<string, unknown>, RegExp]> = [
			[{}, /target\.type debe ser uno de command, http/],
			[{ target: { type: "http", url: "file:///etc/passwd" } }, /target\.url debe usar http: o https:/],
			[{ target: { type: "http", url: "http://user:secret@127.0.0.1/x" } }, /no puede llevar credenciales/],
			[{ target: { type: "command", command: "" } }, /target\.command debe ser un ejecutable/],
			[{ target: { type: "command", command: "x", args: "--flag" } }, /target\.args debe ser una lista/],
			[{ events: ["prompt"], target: { type: "http", url: "http://127.0.0.1/x" } }, /events debe ser una lista no vacía de turn_start, activity_end/],
			[{ timeoutMs: SESSION_SIGNALS.MAX_TIMEOUT_MS + 1, target: { type: "http", url: "http://127.0.0.1/x" } }, /timeoutMs debe ser un entero/],
		];
		for (const [config, expected] of invalid) {
			writeConfig(paths.configHome, config);
			assert.throws(() => loadSessionSignalsConfig(paths.configHome), expected, JSON.stringify(config));
		}
		writeConfig(paths.configHome, { enabled: false, target: { type: "http", url: "http://127.0.0.1/x" } });
		assert.equal(loadSessionSignalsConfig(paths.configHome)?.enabled, false);
	} finally { paths.dispose(); }
});
