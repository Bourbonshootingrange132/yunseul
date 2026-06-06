import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { Writable } from 'stream';
import type { ChildProcess } from 'child_process';
import {
	ClaudeCodeClient,
	STDERR_MAX_CHARS,
	STDERR_TRUNCATION_MARKER,
	splitMessages,
	type ClaudeCodeIO,
} from '../src/claude-code/client';
import { FileSystemAdapter } from '../tests/_stubs/obsidian';
import type { StreamChatOpts } from '../src/llm/types';

// MockChildProcess mimics just enough of node's ChildProcess to drive
// the client's stdout/stderr/exit lifecycle from the tests.
class MockChildProcess extends EventEmitter {
	stdin: Writable | null;
	stdout: EventEmitter;
	stderr: EventEmitter;
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	killSignals: NodeJS.Signals[] = [];
	stdinWrites: string[] = [];
	stdinEnded = false;

	constructor(opts: { withStdin?: boolean } = {}) {
		super();
		this.stdout = new EventEmitter();
		this.stderr = new EventEmitter();
		if (opts.withStdin !== false) {
			const writes = this.stdinWrites;
			// We track the call to end() directly rather than the
			// 'finish' event because the Writable's finish event fires
			// on the next macrotask, which is awkward under fake timers.
			const self = this;
			const stdinAny = new Writable({
				write(chunk, _enc, cb) {
					writes.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
					cb();
				},
			}) as Writable & { end: Writable['end'] };
			const origEnd = stdinAny.end.bind(stdinAny);
			stdinAny.end = function (...args: unknown[]): Writable {
				self.stdinEnded = true;
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				return origEnd(...(args as [any, any?, any?]));
			} as Writable['end'];
			this.stdin = stdinAny;
		} else {
			this.stdin = null;
		}
	}

	kill(signal?: NodeJS.Signals | number): boolean {
		const sig = (typeof signal === 'string' ? signal : 'SIGTERM') as NodeJS.Signals;
		this.killSignals.push(sig);
		return true;
	}

	emitStdout(line: string): void {
		this.stdout.emit('data', Buffer.from(line, 'utf8'));
	}

	emitStderr(line: string): void {
		this.stderr.emit('data', Buffer.from(line, 'utf8'));
	}

	finish(code: number): void {
		this.exitCode = code;
		this.emit('close', code);
	}

	asChildProcess(): ChildProcess {
		// The shape is structural; cast through unknown so we don't
		// invoke the full ChildProcess constructor.
		return this as unknown as ChildProcess;
	}
}

interface TestHarness {
	plugin: ReturnType<typeof makePlugin>;
	io: ClaudeCodeIO;
	spawnCalls: Array<{ cmd: string; args: string[]; opts: { cwd: string; env: NodeJS.ProcessEnv } }>;
	nextProc: MockChildProcess;
	writes: Array<{ path: string; data: string }>;
	unlinks: string[];
	mkdirs: string[];
}

function makePlugin(overrides?: { enableWrites?: boolean; model?: string; binary?: string }): {
	settings: Record<string, unknown>;
	logger: { debug: (...a: unknown[]) => void; info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
	app: { vault: { adapter: FileSystemAdapter; configDir: string } };
	manifest: { id: string };
} {
	return {
		settings: {
			claudeCode: {
				binary: overrides?.binary ?? '',
				modelOverride: overrides?.model ?? '',
				enableWrites: overrides?.enableWrites ?? false,
			},
			debug: false,
		},
		logger: {
			debug: (): void => {},
			info: (): void => {},
			warn: (): void => {},
			error: (): void => {},
		},
		app: {
			vault: {
				adapter: new FileSystemAdapter('/test/vault'),
				configDir: '.obsidian',
			},
		},
		manifest: { id: 'yunseul' },
	};
}

function makeHarness(opts?: { enableWrites?: boolean; model?: string; binary?: string }): TestHarness {
	const plugin = makePlugin(opts);
	const spawnCalls: TestHarness['spawnCalls'] = [];
	const writes: TestHarness['writes'] = [];
	const unlinks: TestHarness['unlinks'] = [];
	const mkdirs: TestHarness['mkdirs'] = [];
	let nextProc = new MockChildProcess();
	const io: ClaudeCodeIO = {
		spawn: (cmd, args, spawnOpts) => {
			spawnCalls.push({ cmd, args, opts: spawnOpts });
			return nextProc.asChildProcess();
		},
		writeFile: async (path, data) => {
			writes.push({ path, data });
		},
		unlink: async (path) => {
			unlinks.push(path);
		},
		mkdir: async (path) => {
			mkdirs.push(path);
		},
	};
	return {
		plugin,
		io,
		spawnCalls,
		get nextProc() {
			return nextProc;
		},
		set nextProc(p: MockChildProcess) {
			nextProc = p;
		},
		writes,
		unlinks,
		mkdirs,
	} as unknown as TestHarness;
}

function makeOpts(overrides: Partial<StreamChatOpts>): StreamChatOpts & { tokens: string[]; completed: boolean; completedMeta: unknown; errored: Error | null; metaEvents: unknown[] } {
	const tokens: string[] = [];
	const metaEvents: unknown[] = [];
	let completed = false;
	let completedMeta: unknown = undefined;
	let errored: Error | null = null;
	const baseSignal = new AbortController().signal;
	return {
		messages: [],
		signal: baseSignal,
		onToken: (t: string): void => {
			tokens.push(t);
		},
		onComplete: (meta?: unknown): void => {
			completed = true;
			completedMeta = meta;
		},
		onError: (err: Error): void => {
			errored = err;
		},
		onMeta: (m: unknown): void => {
			metaEvents.push(m);
		},
		get tokens(): string[] {
			return tokens;
		},
		get completed(): boolean {
			return completed;
		},
		get completedMeta(): unknown {
			return completedMeta;
		},
		get errored(): Error | null {
			return errored;
		},
		get metaEvents(): unknown[] {
			return metaEvents;
		},
		...overrides,
	} as StreamChatOpts & { tokens: string[]; completed: boolean; completedMeta: unknown; errored: Error | null; metaEvents: unknown[] };
}

// Helper to yield to the microtask queue so async event emissions
// schedule before assertions.
//
// We drain the microtask queue by awaiting many times in a row rather
// than relying on a fixed hop count of `Promise.resolve()` calls. The
// streamChat client wires up listeners across multiple microtask hops
// (spawn → on('data')/on('close') wiring → readline-style chunk
// dispatch); the exact hop count is an internal detail we don't want
// the tests to depend on. Twenty iterations is far more than the
// current internal hop count and completes synchronously when the
// queue is already idle, so this is essentially a no-cost
// stabilization.
const flush = async (): Promise<void> => {
	for (let i = 0; i < 20; i++) {
		await Promise.resolve();
	}
};

describe('ClaudeCodeClient.streamChat — argv assembly', () => {
	it('includes Read,Grep,Glob only when writes are disabled', async () => {
		const harness = makeHarness({ enableWrites: false });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const client = new ClaudeCodeClient(harness.plugin as any, harness.io);
		const opts = makeOpts({ messages: [{ role: 'user', content: 'hello' }] });
		void client.streamChat(opts);
		await flush();
		const call = harness.spawnCalls[0];
		expect(call).toBeDefined();
		// Use non-null assertion after toBeDefined(): if `call` is
		// undefined the prior expect already fails the test. Soft-guard
		// with `if (call === undefined) return;` would silently green
		// the test if the spawn fan-out ever regressed.
		const allowedIdx = call!.args.indexOf('--allowedTools');
		expect(allowedIdx).toBeGreaterThan(-1);
		expect(call!.args[allowedIdx + 1]).toBe('Read,Grep,Glob');
		expect(call!.args).not.toContain('--permission-mode');
		harness.nextProc.finish(0);
	});

	it('appends Edit,Write to allowedTools when writes are enabled and sets permission-mode acceptEdits', async () => {
		const harness = makeHarness({ enableWrites: true });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const client = new ClaudeCodeClient(harness.plugin as any, harness.io);
		const opts = makeOpts({ messages: [{ role: 'user', content: 'hello' }] });
		void client.streamChat(opts);
		await flush();
		const call = harness.spawnCalls[0];
		expect(call).toBeDefined();
		const allowedIdx = call!.args.indexOf('--allowedTools');
		expect(call!.args[allowedIdx + 1]).toBe('Read,Grep,Glob,Edit,Write');
		const permIdx = call!.args.indexOf('--permission-mode');
		expect(permIdx).toBeGreaterThan(-1);
		expect(call!.args[permIdx + 1]).toBe('acceptEdits');
		harness.nextProc.finish(0);
	});

	it('passes --resume <sessionId> only when extras carries a session id', async () => {
		const harness = makeHarness();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const client = new ClaudeCodeClient(harness.plugin as any, harness.io);

		// First call — no prior session id, so --resume should be absent.
		const firstOpts = makeOpts({ messages: [{ role: 'user', content: 'first' }] });
		void client.streamChat(firstOpts);
		await flush();
		expect(harness.spawnCalls[0]?.args).not.toContain('--resume');
		harness.nextProc.finish(0);

		// Second call — extras carry the session id captured from the
		// first response. Should add --resume to argv.
		harness.nextProc = new MockChildProcess();
		const secondOpts = makeOpts({
			messages: [{ role: 'user', content: 'follow up' }],
			extras: { claudeCodeSessionId: 'sess-1234' },
		});
		void client.streamChat(secondOpts);
		await flush();
		const secondCall = harness.spawnCalls[1];
		expect(secondCall).toBeDefined();
		const resumeIdx = secondCall!.args.indexOf('--resume');
		expect(resumeIdx).toBeGreaterThan(-1);
		expect(secondCall!.args[resumeIdx + 1]).toBe('sess-1234');
		harness.nextProc.finish(0);
	});

	it('passes --model <id> when claudeModel is set', async () => {
		const harness = makeHarness({ model: 'claude-sonnet-4-5' });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const client = new ClaudeCodeClient(harness.plugin as any, harness.io);
		const opts = makeOpts({ messages: [{ role: 'user', content: 'x' }] });
		void client.streamChat(opts);
		await flush();
		const call = harness.spawnCalls[0];
		expect(call).toBeDefined();
		const modelIdx = call!.args.indexOf('--model');
		expect(modelIdx).toBeGreaterThan(-1);
		expect(call!.args[modelIdx + 1]).toBe('claude-sonnet-4-5');
		harness.nextProc.finish(0);
	});

	it('falls back to `claude` when claudeBinary is empty', async () => {
		const harness = makeHarness({ binary: '' });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const client = new ClaudeCodeClient(harness.plugin as any, harness.io);
		const opts = makeOpts({ messages: [{ role: 'user', content: 'x' }] });
		void client.streamChat(opts);
		await flush();
		expect(harness.spawnCalls[0]?.cmd).toBe('claude');
		harness.nextProc.finish(0);
	});

	it('honors an explicit binary path', async () => {
		const harness = makeHarness({ binary: '/opt/claude/bin/claude' });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const client = new ClaudeCodeClient(harness.plugin as any, harness.io);
		const opts = makeOpts({ messages: [{ role: 'user', content: 'x' }] });
		void client.streamChat(opts);
		await flush();
		expect(harness.spawnCalls[0]?.cmd).toBe('/opt/claude/bin/claude');
		harness.nextProc.finish(0);
	});

	it('always sets stream-json output + verbose + partial messages', async () => {
		const harness = makeHarness();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const client = new ClaudeCodeClient(harness.plugin as any, harness.io);
		const opts = makeOpts({ messages: [{ role: 'user', content: 'x' }] });
		void client.streamChat(opts);
		await flush();
		const args = harness.spawnCalls[0]?.args ?? [];
		expect(args).toContain('--output-format');
		expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json');
		expect(args).toContain('--verbose');
		expect(args).toContain('--include-partial-messages');
		expect(args).toContain('-p');
		harness.nextProc.finish(0);
	});
});

describe('ClaudeCodeClient.streamChat — NDJSON parsing', () => {
	it('captures session_id from system/init and surfaces via onMeta', async () => {
		const harness = makeHarness();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const client = new ClaudeCodeClient(harness.plugin as any, harness.io);
		const opts = makeOpts({ messages: [{ role: 'user', content: 'x' }] });
		void client.streamChat(opts);
		await flush();
		harness.nextProc.emitStdout(
			JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-abc' }) + '\n',
		);
		await flush();
		expect(opts.metaEvents).toContainEqual({ sessionId: 'sess-abc' });
		harness.nextProc.finish(0);
	});

	it('routes content_block_delta text_delta events to onToken', async () => {
		const harness = makeHarness();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const client = new ClaudeCodeClient(harness.plugin as any, harness.io);
		const opts = makeOpts({ messages: [{ role: 'user', content: 'x' }] });
		void client.streamChat(opts);
		await flush();
		harness.nextProc.emitStdout(
			JSON.stringify({
				type: 'stream_event',
				event: {
					type: 'content_block_delta',
					delta: { type: 'text_delta', text: 'Hello' },
				},
			}) + '\n',
		);
		harness.nextProc.emitStdout(
			JSON.stringify({
				type: 'stream_event',
				event: {
					type: 'content_block_delta',
					delta: { type: 'text_delta', text: ' world' },
				},
			}) + '\n',
		);
		await flush();
		expect(opts.tokens).toEqual(['Hello', ' world']);
		harness.nextProc.finish(0);
	});

	it('populates totalCostUsd and sessionId from result event', async () => {
		const harness = makeHarness();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const client = new ClaudeCodeClient(harness.plugin as any, harness.io);
		const opts = makeOpts({ messages: [{ role: 'user', content: 'x' }] });
		void client.streamChat(opts);
		await flush();
		harness.nextProc.emitStdout(
			JSON.stringify({ type: 'result', total_cost_usd: 0.00421, session_id: 'sess-final' }) + '\n',
		);
		harness.nextProc.finish(0);
		await flush();
		const meta = opts.completedMeta as { totalCostUsd?: number; sessionId?: string } | undefined;
		// JSON round-trips exact-representable doubles. Use toBe instead
		// of toBeCloseTo so the assertion locks in the literal value;
		// toBeCloseTo with the default precision (2 digits) would pass
		// for any cost between roughly 0 and 0.005.
		expect(meta?.totalCostUsd).toBe(0.00421);
		expect(meta?.sessionId).toBe('sess-final');
	});

	it('reassembles NDJSON events that arrive split across multiple chunks', async () => {
		const harness = makeHarness();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const client = new ClaudeCodeClient(harness.plugin as any, harness.io);
		const opts = makeOpts({ messages: [{ role: 'user', content: 'x' }] });
		void client.streamChat(opts);
		await flush();
		const full = JSON.stringify({
			type: 'stream_event',
			event: {
				type: 'content_block_delta',
				delta: { type: 'text_delta', text: 'multipart' },
			},
		}) + '\n';
		// Split the line across three chunks.
		harness.nextProc.emitStdout(full.slice(0, 20));
		harness.nextProc.emitStdout(full.slice(20, 60));
		harness.nextProc.emitStdout(full.slice(60));
		await flush();
		expect(opts.tokens).toEqual(['multipart']);
		harness.nextProc.finish(0);
	});

	it('handles multiple events in a single stdout chunk', async () => {
		const harness = makeHarness();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const client = new ClaudeCodeClient(harness.plugin as any, harness.io);
		const opts = makeOpts({ messages: [{ role: 'user', content: 'x' }] });
		void client.streamChat(opts);
		await flush();
		const a = JSON.stringify({
			type: 'stream_event',
			event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'A' } },
		});
		const b = JSON.stringify({
			type: 'stream_event',
			event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'B' } },
		});
		harness.nextProc.emitStdout(`${a}\n${b}\n`);
		await flush();
		expect(opts.tokens).toEqual(['A', 'B']);
		harness.nextProc.finish(0);
	});

	it('ignores tool-use and unknown event types without crashing', async () => {
		const harness = makeHarness();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const client = new ClaudeCodeClient(harness.plugin as any, harness.io);
		const opts = makeOpts({ messages: [{ role: 'user', content: 'x' }] });
		void client.streamChat(opts);
		await flush();
		harness.nextProc.emitStdout(
			JSON.stringify({ type: 'tool_use', name: 'Read', input: { path: 'x' } }) + '\n',
		);
		harness.nextProc.emitStdout(
			JSON.stringify({ type: 'mystery_future_event', payload: { a: 1 } }) + '\n',
		);
		harness.nextProc.emitStdout(
			JSON.stringify({
				type: 'stream_event',
				event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'still here' } },
			}) + '\n',
		);
		await flush();
		expect(opts.tokens).toEqual(['still here']);
		expect(opts.errored).toBeNull();
		harness.nextProc.finish(0);
	});

	it('drops malformed (non-JSON) lines silently', async () => {
		const harness = makeHarness();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const client = new ClaudeCodeClient(harness.plugin as any, harness.io);
		const opts = makeOpts({ messages: [{ role: 'user', content: 'x' }] });
		void client.streamChat(opts);
		await flush();
		harness.nextProc.emitStdout('not json at all\n');
		harness.nextProc.emitStdout(
			JSON.stringify({
				type: 'stream_event',
				event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } },
			}) + '\n',
		);
		await flush();
		expect(opts.tokens).toEqual(['ok']);
		expect(opts.errored).toBeNull();
		harness.nextProc.finish(0);
	});

	it('parses a trailing line that did not end with newline', async () => {
		const harness = makeHarness();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const client = new ClaudeCodeClient(harness.plugin as any, harness.io);
		const opts = makeOpts({ messages: [{ role: 'user', content: 'x' }] });
		void client.streamChat(opts);
		await flush();
		// No trailing newline — should be flushed on close.
		harness.nextProc.emitStdout(
			JSON.stringify({
				type: 'stream_event',
				event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'tail' } },
			}),
		);
		harness.nextProc.finish(0);
		await flush();
		expect(opts.tokens).toEqual(['tail']);
	});
});

describe('ClaudeCodeClient.streamChat — lifecycle', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('aborts via SIGTERM then escalates to SIGKILL after 2s', async () => {
		const harness = makeHarness();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const client = new ClaudeCodeClient(harness.plugin as any, harness.io);
		const ctrl = new AbortController();
		const opts = makeOpts({ messages: [{ role: 'user', content: 'x' }], signal: ctrl.signal });
		void client.streamChat(opts);
		await flush();
		ctrl.abort();
		await flush();
		expect(harness.nextProc.killSignals[0]).toBe('SIGTERM');
		// 2s later, SIGKILL fires since exitCode is still null.
		await vi.advanceTimersByTimeAsync(2100);
		expect(harness.nextProc.killSignals).toContain('SIGKILL');
	});

	it('treats aborted close as completion (partial content preserved)', async () => {
		const harness = makeHarness();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const client = new ClaudeCodeClient(harness.plugin as any, harness.io);
		const ctrl = new AbortController();
		const opts = makeOpts({ messages: [{ role: 'user', content: 'x' }], signal: ctrl.signal });
		void client.streamChat(opts);
		await flush();
		harness.nextProc.emitStdout(
			JSON.stringify({
				type: 'stream_event',
				event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } },
			}) + '\n',
		);
		ctrl.abort();
		await flush();
		harness.nextProc.finish(143); // SIGTERM exit code
		await flush();
		expect(opts.completed).toBe(true);
		expect(opts.errored).toBeNull();
		expect(opts.tokens).toEqual(['partial']);
	});

	it('surfaces stderr via onError on non-zero exit', async () => {
		const harness = makeHarness();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const client = new ClaudeCodeClient(harness.plugin as any, harness.io);
		const opts = makeOpts({ messages: [{ role: 'user', content: 'x' }] });
		void client.streamChat(opts);
		await flush();
		harness.nextProc.emitStderr('claude: not logged in\n');
		harness.nextProc.finish(1);
		await flush();
		expect(opts.completed).toBe(false);
		expect(opts.errored).not.toBeNull();
		expect(opts.errored?.message).toContain('claude exited with code 1');
		expect(opts.errored?.message).toContain('not logged in');
	});

	it('truncates extremely long stderr to keep error messages readable', async () => {
		const harness = makeHarness();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const client = new ClaudeCodeClient(harness.plugin as any, harness.io);
		const opts = makeOpts({ messages: [{ role: 'user', content: 'x' }] });
		void client.streamChat(opts);
		await flush();
		// Generate input well over the cap so we exercise the truncation
		// branch even if the constant changes.
		const huge = 'X'.repeat(STDERR_MAX_CHARS * 4);
		harness.nextProc.emitStderr(huge);
		harness.nextProc.finish(1);
		await flush();
		const msg = opts.errored?.message ?? '';
		expect(msg).toContain(STDERR_TRUNCATION_MARKER);
		// The truncated payload is bounded by (STDERR_MAX_CHARS +
		// marker), plus a small prefix from the surrounding
		// `claude exited with code 1: ` framing. We allow a generous
		// 200-char overhead for that prefix.
		const STDERR_FRAMING_OVERHEAD = 200;
		expect(msg.length).toBeLessThanOrEqual(
			STDERR_MAX_CHARS + STDERR_TRUNCATION_MARKER.length + STDERR_FRAMING_OVERHEAD,
		);
	});

	it('writes the user prompt to stdin and ends it', async () => {
		const harness = makeHarness();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const client = new ClaudeCodeClient(harness.plugin as any, harness.io);
		const opts = makeOpts({ messages: [{ role: 'user', content: 'my question' }] });
		void client.streamChat(opts);
		await flush();
		expect(harness.nextProc.stdinWrites.join('')).toContain('my question');
		expect(harness.nextProc.stdinEnded).toBe(true);
		harness.nextProc.finish(0);
	});

	it('cleans up the temp sysprompt file after exit', async () => {
		const harness = makeHarness();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const client = new ClaudeCodeClient(harness.plugin as any, harness.io);
		const opts = makeOpts({
			messages: [
				{ role: 'system', content: 'You are helpful.' },
				{ role: 'user', content: 'hi' },
			],
		});
		void client.streamChat(opts);
		await flush();
		expect(harness.writes.length).toBeGreaterThan(0);
		const written = harness.writes[0];
		expect(written?.data).toContain('You are helpful.');
		harness.nextProc.finish(0);
		await flush();
		expect(harness.unlinks).toContain(written?.path);
	});
});

describe('splitMessages', () => {
	it('combines all system messages into the system prompt', () => {
		const { systemPrompt } = splitMessages(
			[
				{ role: 'system', content: 'A' },
				{ role: 'system', content: 'B' },
				{ role: 'user', content: 'q' },
			],
			false,
		);
		expect(systemPrompt).toBe('A\n\nB');
	});

	it('on a fresh session, serializes the full history with role labels', () => {
		const { userPrompt } = splitMessages(
			[
				{ role: 'system', content: 'sys' },
				{ role: 'user', content: 'first' },
				{ role: 'assistant', content: 'reply' },
				{ role: 'user', content: 'second' },
			],
			false,
		);
		expect(userPrompt).toContain('User: first');
		expect(userPrompt).toContain('Assistant: reply');
		expect(userPrompt).toContain('User: second');
	});

	it('with --resume, sends only the latest user message', () => {
		const { userPrompt } = splitMessages(
			[
				{ role: 'system', content: 'sys' },
				{ role: 'user', content: 'first' },
				{ role: 'assistant', content: 'reply' },
				{ role: 'user', content: 'second' },
			],
			true,
		);
		expect(userPrompt).toBe('second');
	});

	it('handles a turn-only history (no system msgs) without splatting', () => {
		const { systemPrompt, userPrompt } = splitMessages(
			[{ role: 'user', content: 'standalone' }],
			false,
		);
		expect(systemPrompt).toBe('');
		expect(userPrompt).toBe('User: standalone');
	});
});

describe('ClaudeCodeClient.probe', () => {
	it('returns ok when `claude --version` exits 0', async () => {
		const harness = makeHarness();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const client = new ClaudeCodeClient(harness.plugin as any, harness.io);
		const probe = client.probe();
		await flush();
		harness.nextProc.stdout.emit('data', Buffer.from('claude version 1.2.3\n'));
		harness.nextProc.finish(0);
		const result = await probe;
		expect(result.ok).toBe(true);
		expect(result.kind).toBe('ok');
		expect(result.message).toContain('1.2.3');
	});

	it('returns not-found when spawn emits ENOENT', async () => {
		const harness = makeHarness();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const client = new ClaudeCodeClient(harness.plugin as any, harness.io);
		const probe = client.probe();
		await flush();
		const err: NodeJS.ErrnoException = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
		harness.nextProc.emit('error', err);
		const result = await probe;
		expect(result.ok).toBe(false);
		expect(result.kind).toBe('not-found');
		expect(result.message).toContain('not found');
	});

	it('returns exit-error on non-zero exit', async () => {
		const harness = makeHarness();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const client = new ClaudeCodeClient(harness.plugin as any, harness.io);
		const probe = client.probe();
		await flush();
		harness.nextProc.emitStderr('something broke');
		harness.nextProc.finish(2);
		const result = await probe;
		expect(result.ok).toBe(false);
		expect(result.kind).toBe('exit-error');
		expect(result.status).toBe(2);
	});
});

describe('ClaudeCodeClient.listModels', () => {
	it('returns an empty array (Claude Code picks its own model)', async () => {
		const harness = makeHarness();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const client = new ClaudeCodeClient(harness.plugin as any, harness.io);
		expect(await client.listModels()).toEqual([]);
	});
});

describe('ClaudeCodeClient.streamChat — promise lifetime (regression)', () => {
	// Regression for audit blocker #1: streamChat() used to resolve as
	// soon as the subprocess was spawned (before any token arrived),
	// which broke session.isStreaming(), the Stop button, and abort.
	// The contract is that the returned promise resolves only when the
	// subprocess closes (or errors terminally).

	it('does NOT resolve until proc.close fires', async () => {
		const harness = makeHarness();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const client = new ClaudeCodeClient(harness.plugin as any, harness.io);
		const opts = makeOpts({ messages: [{ role: 'user', content: 'x' }] });

		let resolved = false;
		const promise = client.streamChat(opts).then(() => {
			resolved = true;
		});

		// Give the spawn + listener wiring a chance to run, then assert
		// the promise has NOT resolved yet — the subprocess is still
		// "running" from the client's perspective.
		await flush();
		await flush();
		expect(resolved).toBe(false);

		// Drive the subprocess to completion. Only now should the
		// streamChat promise resolve.
		harness.nextProc.finish(0);
		await promise;
		expect(resolved).toBe(true);
		expect(opts.completed).toBe(true);
	});

	it('does NOT resolve until proc.error fires (spawn failure)', async () => {
		const harness = makeHarness();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const client = new ClaudeCodeClient(harness.plugin as any, harness.io);
		const opts = makeOpts({ messages: [{ role: 'user', content: 'x' }] });

		let resolved = false;
		const promise = client.streamChat(opts).then(() => {
			resolved = true;
		});
		await flush();
		await flush();
		expect(resolved).toBe(false);

		const err: NodeJS.ErrnoException = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
		harness.nextProc.emit('error', err);
		await promise;
		expect(resolved).toBe(true);
		expect(opts.errored).not.toBeNull();
	});
});

describe('ClaudeCodeClient.streamChat — terminal callback latch (regression)', () => {
	// Regression for audit high #2: 'error' and 'close' can fire from
	// the same subprocess in succession. The settled latch ensures
	// onError/onComplete fires exactly once.

	it('fires opts.onError exactly once when error then close both arrive', async () => {
		const harness = makeHarness();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const client = new ClaudeCodeClient(harness.plugin as any, harness.io);
		let errorCount = 0;
		let completeCount = 0;
		const opts = makeOpts({
			messages: [{ role: 'user', content: 'x' }],
			onError: (): void => {
				errorCount++;
			},
			onComplete: (): void => {
				completeCount++;
			},
		});
		void client.streamChat(opts);
		await flush();
		const err: NodeJS.ErrnoException = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
		harness.nextProc.emit('error', err);
		// Node's documented behavior: close may still follow error.
		harness.nextProc.finish(1);
		await flush();
		expect(errorCount).toBe(1);
		expect(completeCount).toBe(0);
	});

	it('fires opts.onComplete exactly once when close arrives twice', async () => {
		const harness = makeHarness();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const client = new ClaudeCodeClient(harness.plugin as any, harness.io);
		let completeCount = 0;
		const opts = makeOpts({
			messages: [{ role: 'user', content: 'x' }],
			onComplete: (): void => {
				completeCount++;
			},
		});
		void client.streamChat(opts);
		await flush();
		harness.nextProc.finish(0);
		// Simulate a spurious second close (paranoid, but Node has
		// historical bugs where listeners fire twice in some cases).
		harness.nextProc.emit('close', 0);
		await flush();
		expect(completeCount).toBe(1);
	});
});

describe('ClaudeCodeClient.killAll — clean abort path (regression)', () => {
	// Regression for audit high #3: killAll used to SIGTERM directly,
	// which fell through to the non-zero-exit branch and reported a
	// spurious "claude exited with code null" error. It should mark
	// the process as aborted so the close handler takes the clean
	// onComplete branch.

	it('marks live procs as aborted so close reports onComplete', async () => {
		const harness = makeHarness();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const client = new ClaudeCodeClient(harness.plugin as any, harness.io);
		const opts = makeOpts({ messages: [{ role: 'user', content: 'x' }] });
		void client.streamChat(opts);
		await flush();
		client.killAll();
		// SIGTERM landed; CLI exits with signal (code null on UNIX).
		harness.nextProc.finish(143);
		await flush();
		expect(opts.completed).toBe(true);
		expect(opts.errored).toBeNull();
	});
});

describe('ClaudeCodeClient.streamChat — argv injection guards (regression)', () => {
	// Regression for security audit: priorSessionId and claudeModel
	// must not begin with `-` or otherwise smuggle in an argv flag.

	it('rejects a tampered claudeCodeSessionId that looks like an argv flag', async () => {
		const harness = makeHarness();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const client = new ClaudeCodeClient(harness.plugin as any, harness.io);
		const opts = makeOpts({
			messages: [{ role: 'user', content: 'x' }],
			extras: { claudeCodeSessionId: '--allowedTools' },
		});
		void client.streamChat(opts);
		await flush();
		const call = harness.spawnCalls[0];
		expect(call).toBeDefined();
		// --resume should NOT be present — the tampered id was rejected
		// and a fresh session started instead.
		expect(call!.args).not.toContain('--resume');
		harness.nextProc.finish(0);
	});

	it('rejects a malicious claudeModel override that contains shell chars', async () => {
		const harness = makeHarness({ model: '--allowedTools' });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const client = new ClaudeCodeClient(harness.plugin as any, harness.io);
		const opts = makeOpts({ messages: [{ role: 'user', content: 'x' }] });
		void client.streamChat(opts);
		await flush();
		const call = harness.spawnCalls[0];
		expect(call).toBeDefined();
		// --model not added because the override failed validation.
		expect(call!.args).not.toContain('--model');
		harness.nextProc.finish(0);
	});

	it('accepts a valid namespaced model id with colons and slashes', async () => {
		const harness = makeHarness({ model: 'bedrock:anthropic.claude-3-5' });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const client = new ClaudeCodeClient(harness.plugin as any, harness.io);
		const opts = makeOpts({ messages: [{ role: 'user', content: 'x' }] });
		void client.streamChat(opts);
		await flush();
		const call = harness.spawnCalls[0];
		expect(call).toBeDefined();
		const idx = call!.args.indexOf('--model');
		expect(idx).toBeGreaterThan(-1);
		expect(call!.args[idx + 1]).toBe('bedrock:anthropic.claude-3-5');
		harness.nextProc.finish(0);
	});
});

describe('ClaudeCodeClient.streamChat — env hardening (regression)', () => {
	// Use vi.stubEnv + vi.unstubAllEnvs to manage env mutation. This is
	// the idiomatic vitest pattern: auto-restores on afterEach so a
	// throw inside the test body cannot leak env state into later tests.
	// Also prevents real ANTHROPIC_* env vars on the developer's machine
	// from leaking into the second test's observation (because
	// vi.stubEnv pins the exact value we want).
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('does not pass ELECTRON_RUN_AS_NODE through to the subprocess', async () => {
		vi.stubEnv('ELECTRON_RUN_AS_NODE', '1');
		const harness = makeHarness();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const client = new ClaudeCodeClient(harness.plugin as any, harness.io);
		const opts = makeOpts({ messages: [{ role: 'user', content: 'x' }] });
		void client.streamChat(opts);
		await flush();
		const call = harness.spawnCalls[0];
		expect(call).toBeDefined();
		expect(call!.opts.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
		harness.nextProc.finish(0);
	});

	it('preserves PATH and ANTHROPIC_* env vars to the subprocess', async () => {
		vi.stubEnv('ANTHROPIC_TEST_TOKEN', 'whitelist-me');
		const harness = makeHarness();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const client = new ClaudeCodeClient(harness.plugin as any, harness.io);
		const opts = makeOpts({ messages: [{ role: 'user', content: 'x' }] });
		void client.streamChat(opts);
		await flush();
		const call = harness.spawnCalls[0];
		expect(call).toBeDefined();
		expect(call!.opts.env.PATH).toBeDefined();
		expect(call!.opts.env.ANTHROPIC_TEST_TOKEN).toBe('whitelist-me');
		harness.nextProc.finish(0);
	});
});

describe('ClaudeCodeClient.streamChat — stderr redaction (regression)', () => {
	it('redacts Bearer tokens from the surfaced error message', async () => {
		const harness = makeHarness();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const client = new ClaudeCodeClient(harness.plugin as any, harness.io);
		const opts = makeOpts({ messages: [{ role: 'user', content: 'x' }] });
		void client.streamChat(opts);
		await flush();
		harness.nextProc.emitStderr('auth failed: Authorization: Bearer sk-ant-secret-token-123\n');
		harness.nextProc.finish(1);
		await flush();
		expect(opts.errored?.message).toContain('[REDACTED]');
		expect(opts.errored?.message).not.toContain('sk-ant-secret-token-123');
	});
});

describe('splitMessages — regression on resume + last-assistant tail', () => {
	it('with --resume and assistant tail, walks back to the last user message', () => {
		const { userPrompt } = splitMessages(
			[
				{ role: 'user', content: 'real question' },
				{ role: 'assistant', content: 'tail reply' },
			],
			true,
		);
		expect(userPrompt).toBe('real question');
	});

	it('with --resume and only assistant turns, returns empty user prompt', () => {
		const { userPrompt } = splitMessages(
			[{ role: 'assistant', content: 'orphan' }],
			true,
		);
		expect(userPrompt).toBe('');
	});
});

// Audit T2: hazard paths the existing 42 tests don't cover. Each test
// drives one corner of the subprocess lifecycle: oversized stdout
// buffer (defense against runaway upstream), api_retry surfacing,
// EPIPE on stdin write (subprocess crashed mid-init), and probe
// timeout (claude --version hangs).

describe('ClaudeCodeClient.streamChat — hazard paths (audit T2)', () => {
	it('abandons parsing when the stdout buffer cap is exceeded without a newline', async () => {
		const harness = makeHarness();
		let warned = false;
		harness.plugin.logger.warn = (msg: unknown): void => {
			if (typeof msg === 'string' && msg.includes('buffer exceeded cap')) {
				warned = true;
			}
		};
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const client = new ClaudeCodeClient(harness.plugin as any, harness.io);
		const opts = makeOpts({ messages: [{ role: 'user', content: 'x' }] });
		void client.streamChat(opts);
		await flush();
		// STDOUT_BUFFER_MAX is 8 MB; emit one chunk larger than that
		// without a newline. The handler should warn and discard the
		// buffer rather than stall.
		const huge = 'a'.repeat(9 * 1024 * 1024);
		harness.nextProc.emitStdout(huge);
		await flush();
		expect(warned).toBe(true);
		// No tokens parsed (no newline ever arrived).
		expect(opts.tokens).toEqual([]);
		harness.nextProc.finish(0);
		await flush();
		// Subprocess exit still goes through onComplete cleanly.
		expect(opts.completed).toBe(true);
		expect(opts.errored).toBeNull();
	});

	it('logs a warning when api_retry attempt > 1 is received', async () => {
		const harness = makeHarness();
		let warnedAttempt: number | undefined;
		harness.plugin.logger.warn = (msg: unknown): void => {
			if (typeof msg === 'string') {
				const m = /attempt=(\d+)/.exec(msg);
				if (m !== null) warnedAttempt = Number(m[1]);
			}
		};
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const client = new ClaudeCodeClient(harness.plugin as any, harness.io);
		const opts = makeOpts({ messages: [{ role: 'user', content: 'x' }] });
		void client.streamChat(opts);
		await flush();
		// attempt=2 is the surface-worthy threshold per
		// claude-code/client.ts handleStreamLine logic.
		harness.nextProc.emitStdout(
			JSON.stringify({ type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 3 }) + '\n',
		);
		await flush();
		expect(warnedAttempt).toBe(2);
		harness.nextProc.finish(0);
	});

	it('swallows EPIPE on stdin and lets the close handler report the real failure', async () => {
		const harness = makeHarness();
		// Capture every logger.warn invocation so we can assert both
		// branches of the EPIPE-vs-other-stdin-error guard in
		// client.ts:733. A regression that inverts the guard (or drops
		// the EPIPE check entirely) would still let the close handler
		// fire, so the negative warn-assertion is what pins the
		// "EPIPE is silently swallowed" contract.
		const warnMessages: string[] = [];
		harness.plugin.logger.warn = (msg: unknown): void => {
			if (typeof msg === 'string') warnMessages.push(msg);
		};
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const client = new ClaudeCodeClient(harness.plugin as any, harness.io);
		const opts = makeOpts({ messages: [{ role: 'user', content: 'x' }] });
		// Inject an EPIPE on the next stdin.write — simulates the CLI
		// dying before consuming stdin (auth init crash). Without the
		// listener in client.ts, Node would treat this as an unhandled
		// rejection. With the listener, EPIPE is swallowed silently and
		// the close handler reports the real exit code.
		void client.streamChat(opts);
		await flush();
		const stdin = harness.nextProc.stdin;
		// Re-emit the stdin error event AFTER the write happened to mimic
		// the kernel returning EPIPE asynchronously.
		const epipeErr: NodeJS.ErrnoException = Object.assign(
			new Error('write EPIPE'),
			{ code: 'EPIPE' },
		);
		stdin?.emit('error', epipeErr);
		// Now finish the subprocess with a real failure on stderr.
		harness.nextProc.emitStderr('boot failed\n');
		harness.nextProc.finish(1);
		await flush();
		// No unhandled error from the EPIPE; the close-handler error is
		// the one the caller sees.
		expect(opts.errored).not.toBeNull();
		expect(opts.errored?.message).toContain('exited with code 1');
		// Critical: EPIPE must NOT produce a noisy stdin-error warning.
		// A regression that inverts the `e.code !== 'EPIPE'` guard would
		// pass the rest of the test but trip this assertion.
		expect(warnMessages.some((m) => m.includes('stdin error'))).toBe(false);
	});

	it('warns on a NON-EPIPE stdin error (e.g. EACCES) — pins the other branch of the guard', async () => {
		const harness = makeHarness();
		// Capture warn calls so we can assert the message surfaces.
		const warnMessages: string[] = [];
		harness.plugin.logger.warn = (msg: unknown): void => {
			if (typeof msg === 'string') warnMessages.push(msg);
		};
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const client = new ClaudeCodeClient(harness.plugin as any, harness.io);
		const opts = makeOpts({ messages: [{ role: 'user', content: 'x' }] });
		void client.streamChat(opts);
		await flush();
		const stdin = harness.nextProc.stdin;
		// Non-EPIPE stdin error — must surface to the logger so the user
		// sees the underlying syscall failure rather than a silent
		// hang. EACCES is the canonical "permission denied" case.
		const eaccesErr: NodeJS.ErrnoException = Object.assign(
			new Error('write EACCES'),
			{ code: 'EACCES' },
		);
		stdin?.emit('error', eaccesErr);
		harness.nextProc.finish(0);
		await flush();
		expect(warnMessages.some((m) => m.includes('stdin error') && m.includes('EACCES'))).toBe(true);
	});

	it('kills the probe and returns a sensible result when claude --version hangs (PROBE_TIMEOUT_MS)', async () => {
		// We don't use fake timers here because the probe's setTimeout is
		// scheduled through `window.setTimeout`, and the test environment
		// makes that the same as the global. Use real timers but a short
		// scheduling boundary: assert that AFTER the timeout fires (we
		// drive it via vi.useFakeTimers + advanceTimersByTime), the probe
		// resolves with a spawn-error result and SIGKILL has been issued.
		vi.useFakeTimers();
		try {
			const harness = makeHarness();
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const client = new ClaudeCodeClient(harness.plugin as any, harness.io);
			const probe = client.probe();
			await flush();
			// Subprocess never exits. Advance past PROBE_TIMEOUT_MS (10s)
			// so the timeout setTimeout fires and resolves the probe.
			await vi.advanceTimersByTimeAsync(10_100);
			const result = await probe;
			expect(result.ok).toBe(false);
			expect(result.kind).toBe('spawn-error');
			expect(result.message).toContain('timed out');
			// SIGKILL was issued to the hung subprocess.
			expect(harness.nextProc.killSignals).toContain('SIGKILL');
		} finally {
			vi.useRealTimers();
		}
	});
});
