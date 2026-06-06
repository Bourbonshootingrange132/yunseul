import { spawn } from 'child_process';
import { promises as fsp } from 'fs';
import type YunseulPlugin from '../main';
import { redactSecrets } from '../util/redact';
import { vaultBasePath } from '../util/paths';
import type {
	LLMClient,
	ProbeResult,
	StreamChatOpts,
} from '../llm/types';
import { buildSafeEnv } from './env';
import type { ClaudeCodeIO } from './io';
import { type LiveProc } from './lifecycle';
import { probeBinary } from './probe';
import { streamChat } from './streamChat';

// ClaudeCodeClient wraps the local `claude` CLI as if it were a
// chat-streaming HTTP service. We do not implement the Claude API
// directly — that would require the user to plug in an API key or
// OAuth refresh and re-implement the chunk parser. Instead we ride
// on the existing Claude Code installation: the user has already
// authenticated their CLI (Pro/Max OAuth, Console API key, Bedrock,
// etc.) and we shell out to it. This means no secrets live in
// Yunseul's data.json and the user controls model choice + tool
// permissions through their CLI config.
//
// Subprocess invocation looks like:
//   claude -p --output-format stream-json --verbose
//          --include-partial-messages
//          [--resume <session_id>]
//          --append-system-prompt-file <path>
//          --allowedTools "Read,Grep,Glob[,Edit,Write]"
//          [--permission-mode acceptEdits]
// The user prompt goes on stdin to avoid OS arg-length limits on
// vault excerpts. stdout emits NDJSON events; we parse line-by-line.
// stderr is buffered for surfacing on non-zero exit.
//
// This file is the thin LLMClient surface. The orchestration lives in
// streamChat.ts; subprocess timing in lifecycle.ts; NDJSON parsing in
// ndjson.ts; env hardening in env.ts; sysprompt temp-file IO in
// sysprompt.ts; probe in probe.ts; argv assembly in argv.ts; dispatch
// of the lifecycle outcome in dispatch.ts. See each module's top
// comment for its scope.

// Public-ish hooks for testing. The default implementations call into
// node's child_process and fs APIs; tests can swap them out without
// touching the real filesystem or spawning real processes. We keep
// the override mechanism on the class (constructor opts) rather than
// module-level vi.mock because we want the tests to exercise the
// subprocess lifecycle deterministically, and node's child_process
// doesn't have a sensible inline mock.
//
// The `ClaudeCodeIO` shape lives in io.ts (a leaf module) so streamChat,
// sysprompt, lifecycle, and probe can reference it without forming a
// source-level cycle through this file. Re-exported here so existing
// callers — including tests/claude-code.test.ts — can keep importing
// from the client path.

const DEFAULT_IO: ClaudeCodeIO = {
	spawn,
	// `wx` flag refuses to overwrite an existing file — defense against
	// symlink-replace attacks where a vault-sync (Obsidian Sync, git,
	// Syncthing) drops a stale symlink at the target path.
	writeFile: (p, d) => fsp.writeFile(p, d, { encoding: 'utf8', flag: 'wx' }),
	unlink: (p) => fsp.unlink(p),
	mkdir: async (p, o) => {
		await fsp.mkdir(p, o);
	},
};

// Re-exports for back-compat with tests/claude-code.test.ts:7-10 which
// import these symbols by name from src/claude-code/client. Keeping the
// old import path live means the existing tests need zero churn.
export type { ClaudeCodeIO } from './io';
export { STDERR_MAX_CHARS, STDERR_TRUNCATION_MARKER } from './constants';
export { splitMessages } from './splitMessages';

export class ClaudeCodeClient implements LLMClient {
	private readonly plugin: YunseulPlugin;
	private readonly io: ClaudeCodeIO;
	// Track every live subprocess so plugin.onunload can kill them.
	// We use a Set because there can be multiple in flight if the user
	// opens several sessions or the future code adds parallel tools.
	// Each entry carries a `markAborted` callback so killAll() can flip
	// the per-process aborted flag (which lives in the lifecycle module's
	// closure) before SIGTERM — otherwise the close handler would treat
	// the killed exit as a real error and surface a spurious "exited
	// with code null" message.
	private readonly liveProcs = new Set<LiveProc>();

	constructor(plugin: YunseulPlugin, io: ClaudeCodeIO = DEFAULT_IO) {
		this.plugin = plugin;
		this.io = io;
	}

	async listModels(): Promise<string[]> {
		// The CLI binds its own model based on the user's subscription /
		// auth. We don't enumerate. Returning [] tells the settings UI
		// to hide the dropdown.
		return [];
	}

	/**
	 * Kill every in-flight subprocess. Called from plugin.onunload so
	 * we don't leak processes past plugin disable. Best-effort: we
	 * SIGTERM and don't await — the process group exits asynchronously
	 * and Electron's main process is shutting down anyway.
	 */
	killAll(): void {
		for (const entry of this.liveProcs) {
			try {
				// Mark aborted BEFORE killing so the close handler takes
				// the aborted branch (clean onComplete) rather than the
				// spurious "exited with code null" error branch.
				entry.markAborted();
				entry.proc.kill('SIGTERM');
			} catch (_e) {
				// ignore: process may already be dead
			}
		}
		this.liveProcs.clear();
	}

	async streamChat(opts: StreamChatOpts): Promise<void> {
		await streamChat(
			{
				plugin: this.plugin,
				io: this.io,
				registerLive: (entry) => this.liveProcs.add(entry),
				unregisterLive: (entry) => {
					this.liveProcs.delete(entry);
				},
			},
			opts,
		);
	}

	async probe(): Promise<ProbeResult> {
		const settings = this.plugin.settings;
		const binary = settings.claudeCode.binary.trim().length > 0 ? settings.claudeCode.binary.trim() : 'claude';

		// Bail before spawning if we're not on a FileSystemAdapter — the
		// chat path would fail anyway, and the user deserves a clear
		// message at Test time rather than a generic per-message error.
		try {
			vaultBasePath(this.plugin);
		} catch (_e) {
			return {
				ok: false,
				kind: 'not-found',
				message: 'Claude Code requires desktop Obsidian (FileSystemAdapter).',
			};
		}

		// `claude --version` exits immediately with the CLI version on
		// stdout. No auth required, no network. ENOENT (binary missing)
		// surfaces as spawn error. The probe spawns at process.cwd()
		// (not vaultBasePath) — a binary-discoverability check doesn't
		// need vault state and using process.cwd() avoids a dependency
		// on the adapter for what is really an environment probe.
		return probeBinary(
			{
				io: this.io,
				env: buildSafeEnv(),
				cwd: process.cwd(),
				registerLive: (entry) => this.liveProcs.add(entry),
				unregisterLive: (entry) => {
					this.liveProcs.delete(entry);
				},
				redactStderr: redactSecrets,
			},
			binary,
		);
	}
}
