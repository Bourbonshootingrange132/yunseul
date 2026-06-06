// `claude --version` probe for the Claude Code provider.
//
// Used by the settings 'Test' button to verify the CLI is installed and
// authenticated before the user attempts to chat. Returns a structured
// ProbeResult tagged with the failure kind (not-found, not-logged-in,
// spawn-error, exit-error) so the settings UI can surface actionable
// guidance instead of a raw error blob.
//
// Uses an injected ProbeIO sub-interface (spawn) — does NOT import
// child_process directly, so the test seam in tests/claude-code.test.ts
// (mock ClaudeCodeIO via the client constructor) flows through here
// unchanged. Registers the probe subprocess via registerLive/
// unregisterLive callbacks so killAll() on the orchestrator can reach
// probes too (e.g. user clicked Test then disabled the plugin before
// the probe resolved).

import type { ChildProcess } from 'child_process';
import { PROBE_TIMEOUT_MS } from './constants';
import type { LiveProc } from './lifecycle';
import type { ProbeResult } from '../llm/types';

export interface ProbeIO {
	spawn: (
		cmd: string,
		args: string[],
		opts: { cwd: string; env: NodeJS.ProcessEnv },
	) => ChildProcess;
}

export interface ProbeDeps {
	io: ProbeIO;
	env: NodeJS.ProcessEnv;
	/**
	 * cwd for the spawn. The streaming path uses vaultBasePath, but the
	 * probe path uses process.cwd() — `claude --version` doesn't need the
	 * vault and using process.cwd() avoids a dependency on the vault
	 * adapter for what should be a purely-binary-discoverability check.
	 */
	cwd: string;
	registerLive: (entry: LiveProc) => void;
	unregisterLive: (entry: LiveProc) => void;
	redactStderr: (s: string) => string;
}

/**
 * Spawn `claude --version` and resolve with a ProbeResult. Times out
 * after PROBE_TIMEOUT_MS — a wrapper script with an interactive prompt
 * could otherwise hang the probe forever; capping at 10s keeps the
 * settings UI responsive.
 *
 * ENOENT (binary missing) surfaces as not-found with a hint to set the
 * full path. Auth-failure phrases (not authenticated / login required /
 * etc.) on stderr surface as not-logged-in with a hint to run
 * `claude login`. Anything else is exit-error.
 */
export async function probeBinary(deps: ProbeDeps, binary: string): Promise<ProbeResult> {
	return new Promise<ProbeResult>((resolve) => {
		let proc: ChildProcess;
		try {
			proc = deps.io.spawn(binary, ['--version'], {
				cwd: deps.cwd,
				env: deps.env,
			});
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			resolve({
				ok: false,
				kind: 'spawn-error',
				message: `Failed to spawn ${binary}: ${msg}`,
			});
			return;
		}
		// Register so plugin.onunload can kill the probe if it's still
		// in flight (e.g. user clicked Test then disabled the plugin).
		// The probe has no abort flag of its own, but SIGTERM will
		// surface via the close handler and resolve.
		const liveEntry: LiveProc = {
			proc,
			markAborted: (): void => {
				/* probe has no flag */
			},
		};
		deps.registerLive(liveEntry);

		let stdout = '';
		let stderr = '';
		let settled = false;
		let timeout: number | null = null;
		const settle = (result: ProbeResult): void => {
			if (settled) return;
			settled = true;
			if (timeout !== null) window.clearTimeout(timeout);
			deps.unregisterLive(liveEntry);
			resolve(result);
		};
		timeout = window.setTimeout(() => {
			try {
				proc.kill('SIGKILL');
			} catch (_e) {
				// ignore
			}
			settle({
				ok: false,
				kind: 'spawn-error',
				message: `\`${binary} --version\` timed out after ${PROBE_TIMEOUT_MS / 1000}s`,
			});
		}, PROBE_TIMEOUT_MS);

		proc.stdout?.on('data', (chunk: Buffer | string) => {
			stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
		});
		proc.stderr?.on('data', (chunk: Buffer | string) => {
			stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
		});
		proc.on('error', (err: NodeJS.ErrnoException) => {
			if (err.code === 'ENOENT') {
				settle({
					ok: false,
					kind: 'not-found',
					message: `\`${binary}\` not found on PATH. Run \`which claude\` to locate it and set the full path in Settings.`,
				});
				return;
			}
			settle({
				ok: false,
				kind: 'spawn-error',
				message: `Spawn error: ${err.message}`,
			});
		});
		proc.on('close', (code: number | null) => {
			if (code === 0) {
				settle({
					ok: true,
					status: 0,
					kind: 'ok',
					message: `Claude Code available: ${stdout.trim() || 'version reported'}`,
				});
				return;
			}
			const safeStderr = deps.redactStderr(stderr.trim());
			// Pattern-match common auth-failure phrases so the user
			// sees actionable guidance instead of a raw blob.
			if (/not\s+(authenticated|logged|signed)|login required|please log in|invalid token|expired/i.test(safeStderr)) {
				settle({
					ok: false,
					status: code ?? -1,
					kind: 'not-logged-in',
					message: 'Claude Code is not logged in. Open a terminal and run `claude login`, then click Test again.',
				});
				return;
			}
			settle({
				ok: false,
				status: code ?? -1,
				kind: 'exit-error',
				message: safeStderr || `\`${binary} --version\` exited with code ${code}`,
			});
		});
	});
}
