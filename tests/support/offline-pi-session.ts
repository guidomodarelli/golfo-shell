import { join } from "node:path";
import type { ExtensionFactory, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";

/** One tool call the offline model issues on its first turn of a prompt. */
export interface PlannedToolCall {
	name: string;
	arguments: Record<string, unknown>;
}

/** A tool result the offline model received. */
export interface RecordedToolResult {
	id: string;
	text: string;
	isError: boolean;
}

const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const OFFLINE_PROVIDER = "offline-integrations";
const OFFLINE_MODEL = "fixture";

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => (part && typeof part === "object" && (part as { type?: string }).type === "text" ? (part as { text: string }).text : "")).join("");
}

/**
 * Host UI binding for a headless test: `notify` is recorded, confirmations are
 * declined and every other dialog returns nothing, as an RPC client would.
 */
function recordingUi(notices: Array<{ text: string; level?: string }>): ExtensionUIContext {
	const nothing = () => undefined;
	const ui = {
		notify: (text: string, level?: string) => { notices.push({ text, level }); },
		confirm: async () => false,
		select: async () => undefined,
		input: async () => undefined,
		editor: async () => undefined,
		addAutocompleteProvider: nothing, getEditorComponent: nothing, getEditorText: () => "", onTerminalInput: () => nothing, pasteToEditor: nothing,
		setEditorComponent: nothing, setEditorText: nothing, setFooter: nothing, setHeader: nothing, setHiddenThinkingLabel: nothing, setStatus: nothing,
		setTitle: nothing, setWidget: nothing, setWorkingIndicator: nothing, setWorkingMessage: nothing, setWorkingVisible: nothing,
	};
	return ui as unknown as ExtensionUIContext;
}

/**
 * Real Pi session (real loader, session manager, extension runner and tools)
 * backed by an offline provider: no network and no model calls. Each prompt
 * runs `plan` once (the next queued plan, if any) and then answers "done".
 * `requests` records the text of every message the provider received.
 */
export async function startOfflinePiSession(options: { cwd: string; agentDir: string; extensionFactories: ExtensionFactory[]; tools?: string[]; plans?: PlannedToolCall[][]; sessionManager?: SessionManager }) {
	const results: RecordedToolResult[] = [];
	const notices: Array<{ text: string; level?: string }> = [];
	const requests: string[][] = [];
	const plans = [...(options.plans ?? [])];
	// Automatic compaction stays off; a manual `/compact` keeps almost nothing, so short sessions can compact.
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 1 }, retry: { enabled: false } });
	const runtime = await ModelRuntime.create({ authPath: join(options.agentDir, "offline-auth.json"), modelsPath: null, refreshOnCreate: false });
	let planPending = false;
	runtime.registerProvider(OFFLINE_PROVIDER, {
		api: "offline-integrations-test", apiKey: "offline-dummy", baseUrl: "http://offline.invalid",
		models: [{ id: OFFLINE_MODEL, name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
		streamSimple(model, context) {
			requests.push(context.messages.map((message) => textOf((message as { content?: unknown }).content)));
			for (const message of context.messages) {
				if (message.role === "toolResult" && !results.some((result) => result.id === message.toolCallId)) {
					results.push({ id: message.toolCallId, text: textOf(message.content), isError: message.isError });
				}
			}
			const last = context.messages.at(-1);
			if (last?.role === "user") planPending = true;
			const calls = planPending && last?.role === "user" ? plans.shift() ?? [] : [];
			planPending = false;
			const stream = createAssistantMessageEventStream();
			const message: AssistantMessage = {
				role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), usage: ZERO_USAGE,
				content: (calls.length > 0 ? calls.map((call, index) => ({ type: "toolCall" as const, id: `${call.name}-${results.length + index}`, name: call.name, arguments: call.arguments })) : [{ type: "text" as const, text: "done" }]) as AssistantMessage["content"],
				stopReason: calls.length > 0 ? "toolUse" : "stop",
			};
			queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: message.stopReason as "stop", message }); stream.end(); });
			return stream;
		},
	});
	const loader = new DefaultResourceLoader({ cwd: options.cwd, agentDir: options.agentDir, settingsManager, noExtensions: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: options.extensionFactories });
	await loader.reload();
	const sessionManager = options.sessionManager ?? SessionManager.inMemory();
	const { session } = await createAgentSession({ cwd: options.cwd, agentDir: options.agentDir, modelRuntime: runtime, model: runtime.getModel(OFFLINE_PROVIDER, OFFLINE_MODEL)!, resourceLoader: loader, settingsManager, sessionManager, tools: options.tools ?? ["read"] });
	await session.bindExtensions({ mode: "rpc", uiContext: recordingUi(notices) });
	return { session, sessionManager, results, requests, notices };
}
