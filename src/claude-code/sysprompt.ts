// Persist the assembled system prompt to a temp file so the Claude Code
// CLI can read it via --append-system-prompt-file without hitting OS
// arg-length limits on long vault excerpts.
//
// Uses an injected SyspromptIO sub-interface (mkdir, writeFile, unlink)
// — does NOT import fs/promises directly, so the test seam in
// tests/claude-code.test.ts (which injects a mock ClaudeCodeIO via the
// client constructor) keeps flowing through this module unchanged.
//
// We use cryptographically random nonces (not Math.random) so a
// concurrent send can't collide on the same filename and clobber the
// other's prompt. We also pass the `wx` flag (in the default ClaudeCodeIO
// in client.ts) so a pre-existing file (symlink-replace attack from a
// sync service) causes a clean failure rather than overwriting an
// attacker-chosen target.

import { tmpdir } from 'os';
import { join as joinPath } from 'path';
import { makeNonce } from '../util/guards';

/**
 * Subset of ClaudeCodeIO needed by the sysprompt writer. We accept a
 * subset so this module stays focused on the writeFile / mkdir / unlink
 * surface and the lifecycle / probe modules can ask for their own
 * narrower IO subsets.
 */
export interface SyspromptIO {
	writeFile: (path: string, data: string) => Promise<void>;
	mkdir: (path: string, opts: { recursive: boolean }) => Promise<void>;
	unlink: (path: string) => Promise<void>;
}

export interface SyspromptDeps {
	io: SyspromptIO;
	/** Vault-relative runtime dir (e.g. ".obsidian/plugins/yunseul/runtime"). */
	runtimeDir: string;
	/** Absolute vault base path on disk. */
	vaultBasePath: string;
	warn: (msg: string) => void;
}

/**
 * Write the system prompt to a temp file under the runtime dir. Falls
 * back to OS tmpdir if the runtime path is unwritable (read-only vault,
 * perm error). Returns the absolute path written; the caller is
 * responsible for cleanup via cleanupSysPromptFile (or the lifecycle
 * module's cleanup pass).
 *
 * The fallback to OS tmp is acceptable because the system prompt is
 * non-sensitive (no API key, no user content beyond what they just
 * typed) — a tmp dir leak is not a security issue here.
 */
export async function writeSysPromptFile(
	deps: SyspromptDeps,
	systemPrompt: string,
	priorSessionId: string | null,
): Promise<string> {
	const nonce = makeNonce();
	const idForName = priorSessionId !== null ? sanitizeForFilename(priorSessionId) : 'fresh';
	const fileName = `sysprompt-${idForName}-${nonce}.md`;

	// Preferred: under runtime dir inside the plugin's config dir.
	// Falls back to OS tmp on any error (read-only vault, etc.).
	try {
		const absDir = joinPath(deps.vaultBasePath, deps.runtimeDir);
		await deps.io.mkdir(absDir, { recursive: true });
		const absFile = joinPath(absDir, fileName);
		await deps.io.writeFile(absFile, systemPrompt);
		return absFile;
	} catch (e) {
		deps.warn(
			`claude-code: runtime dir write failed (${e instanceof Error ? e.message : String(e)}); falling back to OS tmp`,
		);
		// fileName is already alphanumeric.dash.dot from
		// sanitizeForFilename + the literal prefix; no normalizePath
		// needed (and normalizePath is for vault-relative paths anyway,
		// not OS paths).
		const absFile = joinPath(tmpdir(), fileName);
		await deps.io.writeFile(absFile, systemPrompt);
		return absFile;
	}
}

/**
 * Best-effort unlink of the temp sysprompt file. Swallows errors —
 * a leaked tmp file is acceptable; failing the subprocess cleanup over
 * a missing temp file would mask the underlying lifecycle outcome.
 */
export async function cleanupSysPromptFile(
	io: Pick<SyspromptIO, 'unlink'>,
	path: string,
): Promise<void> {
	try {
		await io.unlink(path);
	} catch (_e) {
		// best-effort cleanup
	}
}

/**
 * Strip everything that isn't a safe ASCII filename character from the
 * session id before embedding it in the temp filename. Session ids are
 * UUID-like, but defense in depth — a tampered session id from a vault
 * sync could otherwise traverse the filesystem.
 */
export function sanitizeForFilename(s: string): string {
	return s.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
}
