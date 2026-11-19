import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { type ConfigRecord, errorDetail, IntegrationConfigError, isRecord, optionalBoolean, readIntegrationConfig, resolveConfiguredPath } from "./config-file.ts";
import { SESSION_CONTEXT, SESSION_CONTEXT_TRIGGERS, type SessionContextTrigger } from "./constants.ts";

const INTEGRATION = "session-context";
/** Identifier grammar of one context entry. */
const ENTRY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** One block of static text the user declared; it is read, never executed. */
export interface SessionContextEntry {
	id: string;
	text: string;
	/** Moments of the session cycle that deliver it. */
	on: SessionContextTrigger[];
}

export interface SessionContextConfig {
	enabled: boolean;
	/** Whether Gentle Agents children also receive the context (off by default). */
	includeChildren: boolean;
	entries: SessionContextEntry[];
}

/** Details recorded with each delivered block, so a cycle never repeats it. */
export interface SessionContextDetails {
	id: string;
}

/** Data of a `/session-context off|on` entry; without `id` it applies to every entry. */
export interface SessionContextToggle {
	disabled: boolean;
	id?: string;
}

/** Pi `session_start` reasons. */
export type SessionStartReason = "startup" | "reload" | "new" | "resume" | "fork";

const START_REASON_TRIGGER: Readonly<Record<SessionStartReason, SessionContextTrigger>> = {
	startup: "startup",
	new: "clear",
	resume: "resume",
	fork: "fork",
	// A reload keeps the conversation: only what the current cycle lacks is delivered again.
	reload: "resume",
};

export function sessionContextConfigPath(configHome: string): string {
	return join(configHome, SESSION_CONTEXT.CONFIG_FILE);
}

/** Trigger a `session_start` reason opens a cycle with. */
export function triggerForStart(reason: SessionStartReason): SessionContextTrigger {
	return START_REASON_TRIGGER[reason];
}

function invalid(detail: string): IntegrationConfigError {
	return new IntegrationConfigError(`${INTEGRATION}: ${detail}`);
}

function entryText(entry: ConfigRecord, index: number, configHome: string, home: string): string {
	const hasText = entry.text !== undefined;
	const hasFile = entry.file !== undefined;
	if (hasText === hasFile) throw invalid(`entries[${index}] debe declarar exactamente uno de text o file`);
	let text: string;
	if (hasText) {
		if (typeof entry.text !== "string") throw invalid(`entries[${index}].text debe ser un string`);
		text = entry.text;
	} else {
		if (typeof entry.file !== "string" || !entry.file) throw invalid(`entries[${index}].file debe ser una ruta`);
		const path = resolveConfiguredPath(entry.file, configHome, home);
		try { text = readFileSync(path, "utf8"); }
		catch (error) { throw invalid(`entries[${index}].file no se pudo leer (${path}: ${errorDetail(error)})`); }
	}
	if (!text.trim()) throw invalid(`entries[${index}] no tiene texto`);
	if (Buffer.byteLength(text, "utf8") > SESSION_CONTEXT.MAX_ENTRY_BYTES) throw invalid(`entries[${index}] supera ${SESSION_CONTEXT.MAX_ENTRY_BYTES} bytes; se rechaza en vez de recortarse`);
	return text;
}

function entryTriggers(entry: ConfigRecord, index: number): SessionContextTrigger[] {
	if (entry.on === undefined) return [...SESSION_CONTEXT_TRIGGERS];
	const valid = Array.isArray(entry.on) && entry.on.length > 0 && entry.on.every((trigger) => (SESSION_CONTEXT_TRIGGERS as readonly unknown[]).includes(trigger));
	if (!valid) throw invalid(`entries[${index}].on debe ser una lista no vacía de ${SESSION_CONTEXT_TRIGGERS.join(", ")}`);
	return [...new Set(entry.on as SessionContextTrigger[])];
}

/**
 * Reads `session-context.json`. A missing file means "no session context";
 * any malformed entry rejects the whole file. Text comes only from the file
 * itself or from files it names: nothing is executed to obtain it.
 */
export function loadSessionContextConfig(configHome: string, home: string = homedir()): SessionContextConfig | undefined {
	const raw = readIntegrationConfig(INTEGRATION, sessionContextConfigPath(configHome), SESSION_CONTEXT.CONFIG_SCHEMA);
	if (!raw) return undefined;
	const enabled = optionalBoolean(INTEGRATION, raw, "enabled", true);
	const includeChildren = optionalBoolean(INTEGRATION, raw, "includeChildren", false);
	if (!Array.isArray(raw.entries)) throw invalid("entries debe ser una lista");
	const identifiers = new Set<string>();
	const entries: SessionContextEntry[] = [];
	for (const [index, value] of raw.entries.entries()) {
		if (!isRecord(value)) throw invalid(`entries[${index}] debe ser un objeto`);
		if (typeof value.id !== "string" || !ENTRY_ID_PATTERN.test(value.id) || identifiers.has(value.id)) throw invalid(`entries[${index}].id debe ser único y usar minúsculas, dígitos, '.', '_' o '-'`);
		identifiers.add(value.id);
		if (!optionalBoolean(INTEGRATION, value, "enabled", true)) continue;
		entries.push({ id: value.id, text: entryText(value, index, configHome, home), on: entryTriggers(value, index) });
	}
	return { enabled, includeChildren, entries };
}

/**
 * Entries switched off in this session by `/session-context off`, replayed
 * from the session branch so the choice survives reloads and compaction.
 */
export function disabledEntries(branch: readonly SessionEntry[]): { all: boolean; ids: Set<string> } {
	let all = false;
	const ids = new Set<string>();
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== SESSION_CONTEXT.STATE_ENTRY_TYPE || !isRecord(entry.data)) continue;
		const toggle = entry.data as unknown as SessionContextToggle;
		if (typeof toggle.disabled !== "boolean") continue;
		if (toggle.id === undefined) { all = toggle.disabled; ids.clear(); continue; }
		if (toggle.disabled) ids.add(toggle.id);
		else ids.delete(toggle.id);
	}
	return { all, ids };
}

/** Whether an entry is switched off in this session. */
export function isEntryDisabled(state: { all: boolean; ids: ReadonlySet<string> }, id: string): boolean {
	return state.all || state.ids.has(id);
}

/**
 * Ids already delivered in the current context cycle: delivered blocks after
 * the first entry the last compaction kept (or anywhere, without compaction).
 */
export function deliveredInCycle(branch: readonly SessionEntry[]): Set<string> {
	let start = 0;
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type !== "compaction") continue;
		const kept = branch.findIndex((candidate) => candidate.id === entry.firstKeptEntryId);
		start = kept >= 0 ? kept : index;
		break;
	}
	const delivered = new Set<string>();
	for (const entry of branch.slice(start)) {
		if (entry.type !== "custom_message" || entry.customType !== SESSION_CONTEXT.MESSAGE_TYPE || !Array.isArray(entry.details)) continue;
		for (const detail of entry.details) if (isRecord(detail) && typeof detail.id === "string") delivered.add(detail.id);
	}
	return delivered;
}

/**
 * Entries to deliver for `trigger`: configured for it, not switched off and not
 * already delivered or queued in this cycle.
 */
export function entriesToDeliver(config: SessionContextConfig, trigger: SessionContextTrigger, branch: readonly SessionEntry[], queued: ReadonlySet<string>): SessionContextEntry[] {
	if (!config.enabled) return [];
	const disabled = disabledEntries(branch);
	const delivered = deliveredInCycle(branch);
	return config.entries.filter((entry) => entry.on.includes(trigger) && !isEntryDisabled(disabled, entry.id) && !delivered.has(entry.id) && !queued.has(entry.id));
}
