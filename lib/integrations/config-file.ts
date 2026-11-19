import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** A JSON object read from an integration configuration file. */
export type ConfigRecord = Record<string, unknown>;

/** Error for a configuration file that does not follow its contract. */
export class IntegrationConfigError extends Error {}

export function isRecord(value: unknown): value is ConfigRecord {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Reads an optional integration configuration. A missing file returns
 * `undefined` (the integration stays inactive); invalid JSON, another schema or
 * a non-object rejects the whole file with a message naming the file.
 */
export function readIntegrationConfig(integration: string, path: string, schema: string): ConfigRecord | undefined {
	if (!existsSync(path)) return undefined;
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new IntegrationConfigError(`${integration}: JSON inválido en ${path}`, { cause: error });
	}
	if (!isRecord(raw)) throw new IntegrationConfigError(`${integration}: ${path} debe ser un objeto JSON`);
	if (raw.schema !== schema) throw new IntegrationConfigError(`${integration}: ${path} debe declarar "schema": "${schema}"`);
	return raw;
}

/** Optional boolean field; anything other than a boolean rejects the file. */
export function optionalBoolean(integration: string, record: ConfigRecord, field: string, fallback: boolean): boolean {
	const value = record[field];
	if (value === undefined) return fallback;
	if (typeof value !== "boolean") throw new IntegrationConfigError(`${integration}: ${field} debe ser true o false`);
	return value;
}

/**
 * Resolves a path written in a configuration file: absolute as is, `~/…`
 * against the home directory, anything else against the config home. No fixed
 * personal path is ever assumed.
 */
export function resolveConfiguredPath(value: string, configHome: string, home: string = homedir()): string {
	if (value === "~" || /^~[\\/]/.test(value)) return resolve(join(home, value.slice(1)));
	return isAbsolute(value) ? resolve(value) : resolve(configHome, value);
}

/** Short description of an error for diagnostics, without the stack. */
export function errorDetail(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
