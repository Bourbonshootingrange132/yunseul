import { FileSystemAdapter, normalizePath, type Plugin } from 'obsidian';

// Thin wrappers around `normalizePath()` for plugin-data paths.
// Centralized so every caller can't forget to normalize, and so the
// plugin-data prefix lives in exactly one place. We read the config
// directory off the vault rather than hardcoding `.obsidian` because
// the user may have customized it (Obsidian supports a non-default
// config dir on disk).

export function pluginDataPath(plugin: Plugin, ...parts: string[]): string {
	const id = plugin.manifest.id;
	const configDir = plugin.app.vault.configDir;
	const joined = [configDir, 'plugins', id, ...parts].join('/');
	return normalizePath(joined);
}

export function sessionsDir(plugin: Plugin): string {
	return pluginDataPath(plugin, 'sessions');
}

export function sessionFile(plugin: Plugin, id: string): string {
	return pluginDataPath(plugin, 'sessions', `${id}.json`);
}

// `.yunseul/` is a vault-root sibling to `.obsidian/`. Per the plan,
// indexing artefacts live OUTSIDE the plugin folder so they survive
// plugin reinstall (and so the user can add the path to ignore lists
// for Syncthing/iCloud). The directory is hidden from Vault APIs —
// callers must use vault.adapter for reads/writes.
//
// The `plugin` parameter is unused today (the path is literally
// `.yunseul`) but is accepted so future work can derive a per-plugin
// subdirectory or per-vault override without breaking callers.
export function vaultDataDir(_plugin: Plugin): string {
	return normalizePath('.yunseul');
}

export function bm25IndexPath(plugin: Plugin): string {
	return normalizePath(`${vaultDataDir(plugin)}/bm25-index.json`);
}

/**
 * Absolute path to the vault root on disk. Only meaningful on desktop
 * — Obsidian Mobile uses a Capacitor/Android sandbox where this
 * concept doesn't translate. The Claude Code provider requires this
 * (it spawns the `claude` CLI with cwd = vault root so the CLI's Read/
 * Edit tools resolve note paths). Throws if the active adapter isn't
 * a `FileSystemAdapter`. Callers that only run on desktop (the plugin
 * is marked `isDesktopOnly: true`) can rely on this throwing being a
 * misconfiguration rather than a normal flow.
 */
export function vaultBasePath(plugin: Plugin): string {
	const adapter = plugin.app.vault.adapter;
	if (adapter instanceof FileSystemAdapter) {
		return adapter.getBasePath();
	}
	throw new Error(
		'Vault base path is only available with FileSystemAdapter (desktop). The Claude Code provider requires desktop Obsidian.',
	);
}

/**
 * Plugin-owned runtime scratch directory. Used for temp files we
 * write per-call (the Claude Code provider's
 * `--append-system-prompt-file` lands here). Kept under the plugin's
 * config dir so it disappears on uninstall.
 */
export function runtimeDir(plugin: Plugin): string {
	return pluginDataPath(plugin, 'runtime');
}
