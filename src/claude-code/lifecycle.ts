// Subprocess lifecycle for the Claude Code CLI.
//
// Owns: spawn (via injected IO.spawn), stdin write+end with EPIPE
// swallow, abort handling (SIGTERM → SIGKILL after
// SIGTERM_TO_SIGKILL_MS), settled-latch coordination for the
// error/close double-fire hazard, and cleanup of listeners on the
// terminal callback.
//
// Does NOT own NDJSON parsing or sysprompt cleanup — the orchestrator
// (streamChat.ts) wires NdjsonBuffer.push/flush into the
// onStdout/onTerminate callbacks we accept here, and unlinks the temp
// sysprompt file inside onTerminate.

import type { ChildProcess } from 'child_process';
import { SIGTERM_TO_SIGKILL_MS, STDERR_BUFFER_MAX } from './constants';

/** Subset of ClaudeCodeIO needed by the lifecycle. */
export interface SubprocessIO {
	spawn: (
		cmd: string,
		args: string[],
		opts: { cwd: string; env: NodeJS.ProcessEnv },
	) => ChildProcess;
}

/**
 * Tagged-union outcome reported to the orchestrator's onTerminate hook.
 *   - 'complete':      clean close, exitCode 0.
 *   - 'aborted':       close after the AbortSignal fired (mirror LM
 *                      Studio's abort: treat as clean to preserve
 *                      partial content).
 *   - 'spawn-throw':   io.spawn() threw synchronously.
 *   - 'spawn-enoent':  proc.on('error') fired with code='ENOENT'.
 *   - 'spawn-error':   proc.on('error') fired with non-ENOENT code.
 *   - 'exit-error':    close fired with non-zero exit code.
 */
export type LifecycleOutcome =
	| { kind: 'complete'; exitCode: number; stderrTail: string }
	| { kind: 'aborted'; exitCode: number | null; stderrTail: string }
	| { kind: 'spawn-throw'; message: string }
	| { kind: 'spawn-enoent' }
	| { kind: 'spawn-error'; message: string }
	| { kind: 'exit-error'; exitCode: number | null; stderrTail: string };

export interface LifecycleHandlers {
	onStdout: (chunk: Buffer | string) => void;
	onStderr: (chunk: Buffer | string) => void;
	/** Fired exactly once when the subprocess settles (or fails to spawn). */
	onTerminate: (outcome: LifecycleOutcome) => void;
	/** EPIPE is swallowed silently; non-EPIPE stdin errors surface here. */
	onStdinError: (message: string) => void;
}

/**
 * Registration entry so killAll() on the orchestrator can reach
 * processes spawned both here AND in probe.ts. The orchestrator owns
 * the liveProcs Set; we just signal entry/exit lifetime.
 */
export interface LiveProc {
	proc: ChildProcess;
	markAborted: () => void;
}

export interface LifecycleArgs {
	binary: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	signal: AbortSignal;
	stdinPayload: string;
}

/**
 * Spawn the subprocess and wire up stdout/stderr/abort lifecycle.
 * Returns a Promise that resolves only when the subprocess closes (or
 * errors terminally). Resolves via onTerminate; never throws. The caller
 * (streamChat) awaits this promise so the upstream ChatSession.send sees
 * the in-flight stream for the full lifetime of the subprocess —
 * critical for Stop button behavior, isStreaming() correctness, and
 * avoiding concurrent sends.
 */
export function runSubprocess(
	io: SubprocessIO,
	args: LifecycleArgs,
	handlers: LifecycleHandlers,
	registerLive: (entry: LiveProc) => void,
	unregisterLive: (entry: LiveProc) => void,
): Promise<void> {
	return new Promise<void>((resolve) => {
		// Single-fire latch. Both `error` and `close` can fire from
		// Node for the same subprocess (e.g. ENOENT triggers `error`
		// then `close` with code null). Without the latch the user
		// would see both onError and onComplete, the chat view would
		// double-finalize the bubble, and persistSession would write
		// twice. This is the single biggest correctness hazard in the
		// subprocess lifecycle.
		let settled = false;
		let aborted = false;

		let proc: ChildProcess;
		try {
			proc = io.spawn(args.binary, args.args, {
				cwd: args.cwd,
				env: args.env,
			});
		} catch (e) {
			if (!settled) {
				settled = true;
				const msg = e instanceof Error ? e.message : String(e);
				handlers.onTerminate({ kind: 'spawn-throw', message: msg });
			}
			resolve();
			return;
		}

		const liveEntry: LiveProc = {
			proc,
			markAborted: (): void => {
				aborted = true;
			},
		};
		registerLive(liveEntry);

		const stderrDecoder = new TextDecoder();
		let stderrBuf = '';
		// We use window.setTimeout (not the Node setTimeout) because
		// the plugin runs inside Electron's renderer and the obsidianmd
		// lint rule enforces popout-window-safe timer ownership.
		let sigkillTimer: number | null = null;

		const cleanup = (): void => {
			if (sigkillTimer !== null) window.clearTimeout(sigkillTimer);
			unregisterLive(liveEntry);
			args.signal.removeEventListener('abort', onAbort);
			// Detach stdout/stderr listeners so a late flush after the
			// terminal callback can't deliver tokens to an already-
			// completed/errored consumer.
			proc.stdout?.removeAllListeners('data');
			proc.stderr?.removeAllListeners('data');
		};

		// Abort handling: SIGTERM immediately, then SIGKILL after 2s if
		// the process is still running. We mark `aborted=true` so the
		// close handler treats the non-zero exit as user-initiated
		// rather than a real error.
		const onAbort = (): void => {
			aborted = true;
			killWithEscalation(proc, (timer) => { sigkillTimer = timer; });
		};
		if (args.signal.aborted) {
			onAbort();
		} else {
			args.signal.addEventListener('abort', onAbort, { once: true });
		}

		proc.stdout?.on('data', (chunk: Buffer | string) => {
			if (settled) return;
			handlers.onStdout(chunk);
		});

		proc.stderr?.on('data', (chunk: Buffer | string) => {
			if (settled) return;
			// Cap the buffer — keep the tail since the last error is
			// usually the relevant one. A misbehaving CLI that spams
			// MB to stderr shouldn't pin that memory.
			const text = typeof chunk === 'string' ? chunk : stderrDecoder.decode(chunk, { stream: true });
			stderrBuf += text;
			if (stderrBuf.length > STDERR_BUFFER_MAX) {
				stderrBuf = stderrBuf.slice(-STDERR_BUFFER_MAX);
			}
			// Pass the original (Buffer | string) chunk to the
			// orchestrator so the callback signature stays uniform;
			// the orchestrator decodes again with its own TextDecoder.
			handlers.onStderr(chunk);
		});

		const settle = (outcome: LifecycleOutcome): void => {
			if (settled) return;
			settled = true;
			cleanup();
			handlers.onTerminate(outcome);
			resolve();
		};

		proc.on('error', (err: NodeJS.ErrnoException) => {
			// `error` fires before `close` when the spawn itself failed
			// (binary missing, ENOEXEC). The settled latch makes sure
			// the user only sees one terminal callback.
			if (err.code === 'ENOENT') {
				settle({ kind: 'spawn-enoent' });
			} else {
				settle({ kind: 'spawn-error', message: err.message });
			}
		});

		proc.on('close', (code: number | null) => {
			if (aborted) {
				settle({ kind: 'aborted', exitCode: code, stderrTail: stderrBuf });
			} else if (code === 0) {
				settle({ kind: 'complete', exitCode: code, stderrTail: stderrBuf });
			} else {
				settle({ kind: 'exit-error', exitCode: code, stderrTail: stderrBuf });
			}
		});

		pumpStdin(proc, args.stdinPayload, handlers.onStdinError);
	});
}

/**
 * SIGTERM the subprocess, then escalate to SIGKILL after
 * SIGTERM_TO_SIGKILL_MS if it's still running. The caller passes a
 * setter for the timer handle so cleanup() can clear it.
 */
function killWithEscalation(
	proc: ChildProcess,
	setTimer: (timer: number) => void,
): void {
	try {
		proc.kill('SIGTERM');
	} catch (_e) {
		// ignore; process may already be gone
	}
	const handle = window.setTimeout(() => {
		if (proc.exitCode === null && proc.signalCode === null) {
			try {
				proc.kill('SIGKILL');
			} catch (_e) {
				// ignore
			}
		}
	}, SIGTERM_TO_SIGKILL_MS);
	setTimer(handle);
}

/**
 * Pipe the user prompt into stdin, then close stdin so the CLI can
 * start. If stdin isn't writable (testing seam), skip the write — the
 * test's mock subprocess sets stdin to null deliberately when the user
 * prompt isn't relevant.
 *
 * Defensive stdin error handler: if the subprocess exits before
 * consuming stdin (CLI crashes during init, auth failure surfaced to
 * stderr and quick-exit), the kernel returns EPIPE on the parent's
 * write. Without a listener Node would treat this as an uncaught
 * exception ("Error: write EPIPE") that propagates as an unhandled
 * promise rejection and bypasses our onError contract. The close
 * handler reports the real failure cause; we just swallow.
 *
 * write/end are wrapped in try/catch in case the stream throws
 * synchronously (rare — writing to an already-destroyed stream). The
 * kernel can still deliver an asynchronous 'error' event after write()
 * returns, which the listener above catches.
 */
function pumpStdin(
	proc: ChildProcess,
	payload: string,
	onStdinError: (message: string) => void,
): void {
	const stdin = proc.stdin;
	if (stdin === null) return;
	stdin.on('error', (e: NodeJS.ErrnoException) => {
		if (e.code !== 'EPIPE') {
			onStdinError(e.message);
		}
	});
	try {
		stdin.write(payload);
	} catch (_e) {
		// Synchronous throw from write() (rare). Swallow; the close
		// handler reports the real failure.
	}
	try {
		stdin.end();
	} catch (_e) {
		// stdin already closed; close handler reports the underlying
		// cause.
	}
}
