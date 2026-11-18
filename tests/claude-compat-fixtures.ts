import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Synthetic Claude Code installation in a disposable directory; no real configuration is read. */
export interface ClaudeFixture {
	root: string;
	home: string;
	agentHome: string;
	configHome: string;
	write(relativePath: string, content: string): string;
	plugin(options: { key: string; version: string; scope?: string; enabled?: boolean; files?: Record<string, string> }): string;
	finalize(settings?: Record<string, unknown>): void;
	dispose(): void;
}

export function skillFile(name: string, description = `Synthetic ${name} skill`): string {
	return `---\nname: ${name}\ndescription: ${description}\n---\n\nUse references/guide.md.\n`;
}

export function agentFile(fields: Record<string, string>, body = "Do the synthetic task."): string {
	return `---\n${Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join("\n")}\n---\n\n${body}\n`;
}

export function createClaudeFixture(): ClaudeFixture {
	const root = mkdtempSync(join(tmpdir(), "claude-compat-"));
	const home = join(root, "home");
	const agentHome = join(root, "agent");
	const configHome = join(root, "config");
	for (const directory of [home, agentHome, configHome]) mkdirSync(directory, { recursive: true });
	const installed: Record<string, Array<Record<string, string>>> = {};
	const enabled: Record<string, boolean> = {};
	const write = (relativePath: string, content: string) => {
		const path = join(root, relativePath);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
		return path;
	};
	return {
		root, home, agentHome, configHome, write,
		plugin({ key, version, scope = "user", enabled: isEnabled = true, files = {} }) {
			const installPath = join(home, ".claude", "plugins", "cache", key.replace("@", "-"), version);
			mkdirSync(installPath, { recursive: true });
			for (const [path, content] of Object.entries(files)) {
				mkdirSync(dirname(join(installPath, path)), { recursive: true });
				writeFileSync(join(installPath, path), content);
			}
			(installed[key] ??= []).push({ scope, installPath, version });
			enabled[key] = isEnabled;
			return installPath;
		},
		finalize(settings = {}) {
			write("home/.claude/plugins/installed_plugins.json", JSON.stringify({ version: 2, plugins: installed }));
			write("home/.claude/settings.json", JSON.stringify({ ...settings, enabledPlugins: enabled }));
		},
		dispose() { rmSync(root, { recursive: true, force: true }); },
	};
}
