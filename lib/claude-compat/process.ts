import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { basename, delimiter, extname, isAbsolute, join } from "node:path";
import { HOOK_OUTPUT_LIMIT_BYTES, HOOK_TIMEOUT_MS, NODE_SCRIPT_EXTENSIONS } from "./constants.ts";

export interface ProcessResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface ProcessOptions {
	cwd: string;
	environment?: NodeJS.ProcessEnv;
	input?: string;
	timeoutMs?: number;
	outputLimitBytes?: number;
	signal?: AbortSignal;
}

const WINDOWS_EXECUTABLE_EXTENSIONS = ["", ".exe", ".cmd"];
const WINDOWS_SYSTEM_DIRECTORY = /[\\/]windows[\\/](?:system32|sysnative)[\\/]/i;

/** Resolves an executable from absolute PATH entries only; project-relative entries are ignored. */
export function resolveExecutable(command: string, environment: NodeJS.ProcessEnv = process.env): string {
	if (isAbsolute(command)) {
		if (existsSync(command) && statSync(command).isFile()) return command;
		throw new Error(`claude-compat:resolveExecutable failed: ${basename(command)} is not available`);
	}
	const extensions = process.platform === "win32" ? WINDOWS_EXECUTABLE_EXTENSIONS : [""];
	const path = environment.PATH ?? environment.Path ?? "";
	for (const directory of path.split(delimiter).filter((entry) => isAbsolute(entry))) {
		for (const extension of extensions) {
			const candidate = join(directory, command + extension);
			// System32\bash.exe is the WSL launcher: it would run the hook in another OS.
			if (process.platform === "win32" && WINDOWS_SYSTEM_DIRECTORY.test(candidate)) continue;
			if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
		}
	}
	throw new Error(`claude-compat:resolveExecutable failed: ${basename(command)} is not on PATH`);
}

function terminate(pid: number | undefined, fallback: () => void): void {
	if (!pid) return fallback();
	if (process.platform === "win32") {
		// taskkill /T ends the hook's descendants too; child.kill would orphan them.
		const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
		killer.once("error", fallback);
		return;
	}
	try { process.kill(-pid, "SIGKILL"); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") fallback(); }
}

/**
 * Bounded process: data only through stdin/argv (no shell), killed with its
 * process group on timeout, cancellation or oversized output.
 */
export function runProcess(executable: string, args: readonly string[], options: ProcessOptions): Promise<ProcessResult> {
	const { cwd, environment = process.env, input = "", timeoutMs = HOOK_TIMEOUT_MS, outputLimitBytes = HOOK_OUTPUT_LIMIT_BYTES, signal } = options;
	return new Promise((resolveResult, reject) => {
		const child = spawn(executable, [...args], { cwd, env: environment, shell: false, detached: process.platform !== "win32", windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
		const stop = () => terminate(child.pid, () => child.kill("SIGKILL"));
		let aborted = signal?.aborted ?? false;
		let timedOut = false;
		let oversized = false;
		let bytes = 0;
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		const abort = () => { aborted = true; stop(); };
		signal?.addEventListener("abort", abort, { once: true });
		if (aborted) stop();
		const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
		const collect = (target: Buffer[]) => (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > outputLimitBytes) { if (!oversized) { oversized = true; stop(); } return; }
			target.push(chunk);
		};
		child.stdout.on("data", collect(stdout));
		child.stderr.on("data", collect(stderr));
		child.stdin.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "EPIPE" && error.code !== "EOF") stop(); });
		const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
		child.once("error", (error) => {
			cleanup();
			reject(new Error(`claude-compat:runProcess failed to start ${basename(executable)}`, { cause: error }));
		});
		child.once("close", (code) => {
			cleanup();
			if (aborted) reject(new Error(`claude-compat:runProcess cancelled ${basename(executable)}`));
			else if (timedOut) reject(new Error(`claude-compat:runProcess timed out after ${timeoutMs}ms running ${basename(executable)}`));
			else if (oversized) reject(new Error(`claude-compat:runProcess output of ${basename(executable)} exceeded ${outputLimitBytes} bytes`));
			else resolveResult({ code: code ?? 1, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
		});
		child.stdin.end(input);
	});
}

/** Runs one reviewed hook script with its JSON payload on stdin. */
export function runHookScript(script: string, payload: unknown, options: Omit<ProcessOptions, "input">): Promise<ProcessResult> {
	const environment = options.environment ?? process.env;
	if ((NODE_SCRIPT_EXTENSIONS as readonly string[]).includes(extname(script).toLowerCase())) {
		return runProcess(process.execPath, [script], { ...options, input: JSON.stringify(payload) });
	}
	const scriptArgument = process.platform === "win32" ? script.replaceAll("\\", "/") : script;
	return runProcess(resolveExecutable("bash", environment), [scriptArgument], { ...options, input: JSON.stringify(payload) });
}
