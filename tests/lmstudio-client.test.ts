import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LMClient, LMClientError } from '../src/lmstudio/client';
import {
	resetRequestUrlHandler,
	setRequestUrlHandler,
} from './_stubs/obsidian';
import type { YunseulSettings } from '../src/settings';
import type { StreamChatOpts } from '../src/llm/types';

// LMClient drives the only HTTP/SSE path for the LM Studio / OpenAI-
// compatible providers. We exercise the streamChat happy path, abort
// behavior, error paths (with redaction), and the listModels + probe
// round trips by stubbing global `fetch` and the `requestUrl` shim.

interface LMStudioOverrides {
	baseUrl?: string;
	apiKey?: string;
	chatModel?: string;
	temperature?: number;
	maxContextChars?: number;
	maxConversationRounds?: number;
}

/**
 * Test-only ergonomic shim: tests historically called
 * `makeSettings({ apiKey, baseUrl })` against the flat shape. The new
 * v1 grouped shape buries those under `lmStudio.*`. Accept a flat
 * Partial of common LM-Studio fields as a convenience and apply them
 * into the nested group; tests that need claude-code or index
 * overrides build the full YunseulSettings literal.
 */
function makeSettings(over: LMStudioOverrides = {}): YunseulSettings {
	return {
		schemaVersion: 1,
		provider: 'lm-studio',
		lmStudio: {
			baseUrl: over.baseUrl ?? 'http://localhost:1234/v1',
			apiKey: over.apiKey ?? '',
			chatModel: over.chatModel ?? 'test-model',
			temperature: over.temperature ?? 0.7,
			maxContextChars: over.maxContextChars ?? 12000,
			maxConversationRounds: over.maxConversationRounds ?? 10,
		},
		claudeCode: {
			binary: '',
			modelOverride: '',
			enableWrites: false,
		},
		chat: {
			suggestions: [],
			downloadFolder: 'AI Chats',
		},
		index: {
			enabled: false,
			topK: 8,
			excludeTags: [],
			promptState: 'unanswered',
		},
		privacy: {
			allowExternalImages: false,
			treatClippingsAsUntrusted: true,
			clippingsFolder: 'Clippings',
		},
		debug: false,
	};
}

/**
 * Build a ReadableStream that yields the given chunks as Uint8Array
 * (TextEncoder bytes). Tracks calls to `cancel()` via the `cancelled`
 * field so tests can assert reader.cancel() was invoked on abort.
 */
interface TrackedStream {
	stream: ReadableStream<Uint8Array>;
	cancelled: boolean;
}

function makeTrackedStream(chunks: string[]): TrackedStream {
	const enc = new TextEncoder();
	let i = 0;
	const tracker: TrackedStream = {
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		stream: null as unknown as ReadableStream<Uint8Array>,
		cancelled: false,
	};
	tracker.stream = new ReadableStream<Uint8Array>({
		pull(controller): void {
			if (i < chunks.length) {
				controller.enqueue(enc.encode(chunks[i] ?? ''));
				i += 1;
			} else {
				controller.close();
			}
		},
		cancel(): void {
			tracker.cancelled = true;
		},
	});
	return tracker;
}

/**
 * Build a ReadableStream that emits the first chunk on demand and then
 * "hangs" — controller.enqueue is called once but no `close()` is invoked.
 * Used for the abort-mid-stream test so the read loop is alive when
 * cancel() lands.
 */
interface PendingStream {
	stream: ReadableStream<Uint8Array>;
	cancelled: boolean;
	emit: (data: string) => void;
}

function makePendingStream(): PendingStream {
	const enc = new TextEncoder();
	let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
	const out: PendingStream = {
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		stream: null as unknown as ReadableStream<Uint8Array>,
		cancelled: false,
		emit: (): void => {
			// reassigned below
		},
	};
	out.stream = new ReadableStream<Uint8Array>({
		start(controller): void {
			controllerRef = controller;
		},
		cancel(): void {
			out.cancelled = true;
			try {
				controllerRef?.close();
			} catch (_e) {
				// Already closed by cancel signal — ignore.
			}
		},
	});
	out.emit = (data: string): void => {
		controllerRef?.enqueue(enc.encode(data));
	};
	return out;
}

function makeStreamOpts(over: Partial<StreamChatOpts> = {}): StreamChatOpts & {
	tokens: string[];
	completed: boolean;
	errored: Error | null;
} {
	const tokens: string[] = [];
	let completed = false;
	let errored: Error | null = null;
	return {
		messages: [{ role: 'user', content: 'hi' }],
		signal: new AbortController().signal,
		onToken: (t: string): void => {
			tokens.push(t);
		},
		onComplete: (): void => {
			completed = true;
		},
		onError: (e: Error): void => {
			errored = e;
		},
		get tokens(): string[] {
			return tokens;
		},
		get completed(): boolean {
			return completed;
		},
		get errored(): Error | null {
			return errored;
		},
		...over,
	} as StreamChatOpts & { tokens: string[]; completed: boolean; errored: Error | null };
}

function sseDataLine(payload: object): string {
	return `data: ${JSON.stringify(payload)}\n\n`;
}

// ---------------------------------------------------------------------

describe('LMClient.streamChat', () => {
	beforeEach(() => {
		resetRequestUrlHandler();
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		resetRequestUrlHandler();
	});

	it('streams tokens from concatenated SSE delta events on the happy path', async () => {
		const chunks = [
			sseDataLine({ choices: [{ delta: { content: 'Hello' } }] }),
			sseDataLine({ choices: [{ delta: { content: ' ' } }] }),
			sseDataLine({ choices: [{ delta: { content: 'world' } }] }),
			'data: [DONE]\n\n',
		];
		const tracked = makeTrackedStream(chunks);
		vi.stubGlobal(
			'fetch',
			vi.fn(async (): Promise<Response> => new Response(tracked.stream, { status: 200 })),
		);

		const client = new LMClient(() => makeSettings());
		const opts = makeStreamOpts();
		await client.streamChat(opts);

		expect(opts.tokens.join('')).toBe('Hello world');
		expect(opts.completed).toBe(true);
		expect(opts.errored).toBeNull();
		expect(opts.signal.aborted).toBe(false);
	});

	it('aborts the read loop on signal.abort() and preserves partial tokens', async () => {
		const pending = makePendingStream();
		vi.stubGlobal(
			'fetch',
			vi.fn(async (): Promise<Response> =>
				// Don't wire the abort listener to stream.cancel() here — the
				// LMClient's own abort handler calls reader.cancel() which
				// propagates up the underlying source via the cancel
				// callback. Wiring it here too would trigger "stream is
				// locked" because the reader holds the lock.
				new Response(pending.stream, { status: 200 }),
			),
		);

		const ctrl = new AbortController();
		const client = new LMClient(() => makeSettings());
		const opts = makeStreamOpts({ signal: ctrl.signal });

		const streamPromise = client.streamChat(opts);
		// Emit two tokens, then abort.
		pending.emit(sseDataLine({ choices: [{ delta: { content: 'A' } }] }));
		pending.emit(sseDataLine({ choices: [{ delta: { content: 'B' } }] }));
		// Wait for both tokens to be processed by the SSE read loop
		// before aborting. Using vi.waitFor decouples the test from the
		// exact microtask-hop count of the Response/ReadableStreamDefault
		// Reader implementation — a previous sprinkle of `await
		// Promise.resolve()` calls would break if the runtime added or
		// removed one hop.
		await vi.waitFor(() => {
			if (opts.tokens.length < 2) throw new Error('waiting for both tokens');
		});
		ctrl.abort();
		await streamPromise;

		// On abort the LMClient routes through opts.onComplete (preserving
		// the partial assistant content), not onError.
		expect(opts.completed).toBe(true);
		expect(opts.errored).toBeNull();
		expect(opts.tokens.join('')).toBe('AB');
		// reader.cancel() propagates up through the underlying source's
		// cancel callback, so the tracker observes the cancellation.
		expect(pending.cancelled).toBe(true);
	});

	it('surfaces a non-2xx response via onError with status and redacted secret-shaped body', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (): Promise<Response> => ({
				ok: false,
				status: 401,
				body: null,
				text: async (): Promise<string> =>
					'invalid api key sk-real-token-here-1234567890',
			}) as unknown as Response),
		);

		const client = new LMClient(() =>
			makeSettings({ apiKey: 'sk-real-token-here-1234567890' }),
		);
		const opts = makeStreamOpts();
		await client.streamChat(opts);

		expect(opts.completed).toBe(false);
		expect(opts.errored).toBeInstanceOf(LMClientError);
		const err = opts.errored as LMClientError;
		expect(err.status).toBe(401);
		// The configured api key must not appear verbatim in the surfaced
		// error message after redaction.
		expect(err.message).not.toContain('sk-real-token-here-1234567890');
		expect(err.message).toContain('[REDACTED]');
		expect(err.message).toContain('HTTP 401');
	});

	it('surfaces a fetch() network failure (TypeError CORS/network) via onError with a sanitized message', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (): Promise<Response> => {
				throw new TypeError('Failed to fetch');
			}),
		);

		const client = new LMClient(() => makeSettings());
		const opts = makeStreamOpts();
		await client.streamChat(opts);

		expect(opts.completed).toBe(false);
		expect(opts.errored).toBeInstanceOf(LMClientError);
		expect(opts.errored?.message).toContain('fetch failed');
		expect(opts.errored?.message).toContain('Failed to fetch');
	});

	it('skips malformed SSE chunks silently and still emits valid tokens that follow', async () => {
		const chunks = [
			'data: {malformed json\n\n',
			sseDataLine({ choices: [{ delta: { content: 'ok' } }] }),
			'data: [DONE]\n\n',
		];
		const tracked = makeTrackedStream(chunks);
		vi.stubGlobal(
			'fetch',
			vi.fn(async (): Promise<Response> => new Response(tracked.stream, { status: 200 })),
		);

		const client = new LMClient(() => makeSettings());
		const opts = makeStreamOpts();
		await client.streamChat(opts);

		expect(opts.errored).toBeNull();
		expect(opts.completed).toBe(true);
		expect(opts.tokens).toEqual(['ok']);
	});

	it('exits the read loop cleanly on the [DONE] terminator and fires onComplete once', async () => {
		const chunks = [
			sseDataLine({ choices: [{ delta: { content: 'first' } }] }),
			sseDataLine({ choices: [{ delta: { content: ' last' } }] }),
			'data: [DONE]\n\n',
			// More chunks after [DONE] would be ignored — the read loop
			// has already returned. We still include them to prove they
			// don't slip through.
			sseDataLine({ choices: [{ delta: { content: 'NEVER' } }] }),
		];
		const tracked = makeTrackedStream(chunks);
		vi.stubGlobal(
			'fetch',
			vi.fn(async (): Promise<Response> => new Response(tracked.stream, { status: 200 })),
		);

		let completeCount = 0;
		const client = new LMClient(() => makeSettings());
		const opts = makeStreamOpts({
			onComplete: (): void => {
				completeCount += 1;
			},
		});
		await client.streamChat(opts);

		expect(opts.tokens).toEqual(['first', ' last']);
		expect(completeCount).toBe(1);
	});
});

describe('LMClient.listModels', () => {
	beforeEach(() => {
		resetRequestUrlHandler();
	});
	afterEach(() => {
		// Defense in depth: no test in this block currently stubs fetch,
		// but adjacent describe blocks do. If a future test here is added
		// that stubs fetch, or a prior test in `streamChat` throws before
		// its afterEach runs, this prevents a stubbed `fetch` from
		// leaking into this block's state.
		vi.unstubAllGlobals();
		resetRequestUrlHandler();
	});

	it('round-trips a valid /v1/models payload into a string[] of ids', async () => {
		setRequestUrlHandler(() => ({
			status: 200,
			text: JSON.stringify({
				data: [{ id: 'llama-3.1-8b' }, { id: 'qwen2.5-7b' }],
			}),
			headers: {},
		}));
		const client = new LMClient(() => makeSettings());
		const ids = await client.listModels();
		expect(ids).toEqual(['llama-3.1-8b', 'qwen2.5-7b']);
	});

	it('throws LMClientError on a malformed payload (missing data field)', async () => {
		setRequestUrlHandler(() => ({
			status: 200,
			text: JSON.stringify({ wrong: 'shape' }),
			headers: {},
		}));
		const client = new LMClient(() => makeSettings());
		await expect(client.listModels()).rejects.toBeInstanceOf(LMClientError);
	});
});

describe('LMClient.probe (CORS detection)', () => {
	beforeEach(() => {
		resetRequestUrlHandler();
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		resetRequestUrlHandler();
	});

	it("returns kind='cors-blocked' when fetch throws but requestUrl succeeds", async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (): Promise<Response> => {
				throw new TypeError('Failed to fetch');
			}),
		);
		setRequestUrlHandler(() => ({
			status: 200,
			text: JSON.stringify({ data: [{ id: 'm' }] }),
			headers: {},
		}));
		const client = new LMClient(() => makeSettings());
		const result = await client.probe();
		expect(result.ok).toBe(false);
		expect(result.kind).toBe('cors-blocked');
	});

	it("returns kind='offline' when fetch throws AND requestUrl throws (connection-refused / ENOENT)", async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (): Promise<Response> => {
				throw new TypeError('Failed to fetch');
			}),
		);
		setRequestUrlHandler(() => {
			const err: NodeJS.ErrnoException = Object.assign(
				new Error('connect ECONNREFUSED 127.0.0.1:1234'),
				{ code: 'ECONNREFUSED' },
			);
			throw err;
		});
		const client = new LMClient(() => makeSettings());
		const result = await client.probe();
		expect(result.ok).toBe(false);
		expect(result.kind).toBe('offline');
	});

	it("returns kind='ok' on a successful fetch with 2xx status", async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (): Promise<Response> => new Response(null, { status: 200 })),
		);
		const client = new LMClient(() => makeSettings());
		const result = await client.probe();
		expect(result.ok).toBe(true);
		expect(result.kind).toBe('ok');
	});
});

describe('LMClient.streamChat — secret redaction (via observable error path)', () => {
	beforeEach(() => {
		resetRequestUrlHandler();
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		resetRequestUrlHandler();
	});

	it('redacts a configured Bearer token verbatim from the surfaced error', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (): Promise<Response> => ({
				ok: false,
				status: 500,
				body: null,
				text: async (): Promise<string> =>
					'upstream echoed Bearer sk-abc1234567 to the response body',
			}) as unknown as Response),
		);
		const client = new LMClient(() => makeSettings({ apiKey: 'sk-abc1234567' }));
		const opts = makeStreamOpts();
		await client.streamChat(opts);
		expect(opts.errored?.message).toContain('[REDACTED]');
		expect(opts.errored?.message).not.toContain('sk-abc1234567');
	});

	it('redacts Authorization header text from the surfaced error', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (): Promise<Response> => ({
				ok: false,
				status: 500,
				body: null,
				text: async (): Promise<string> =>
					'request was: Authorization: Bearer xyz-secret-blob-abc',
			}) as unknown as Response),
		);
		const client = new LMClient(() => makeSettings());
		const opts = makeStreamOpts();
		await client.streamChat(opts);
		// Authorization: line is fully replaced, AND the generic Bearer
		// pattern catches the unbounded token after it.
		expect(opts.errored?.message).toContain('Authorization: [REDACTED]');
		expect(opts.errored?.message).not.toContain('xyz-secret-blob-abc');
	});

	it('redacts apiKey=… inline patterns from the surfaced error', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (): Promise<Response> => ({
				ok: false,
				status: 500,
				body: null,
				text: async (): Promise<string> =>
					'bad config: apiKey=mysecret123456 detected in body',
			}) as unknown as Response),
		);
		const client = new LMClient(() => makeSettings());
		const opts = makeStreamOpts();
		await client.streamChat(opts);
		expect(opts.errored?.message).toContain('api_key=[REDACTED]');
		expect(opts.errored?.message).not.toContain('mysecret123456');
	});
});
