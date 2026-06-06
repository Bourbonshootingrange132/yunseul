import { describe, expect, it } from 'vitest';
import { ChatSession } from '../src/chat/session';
import type { LLMClient, StreamChatOpts, StreamCompletionMeta, ProbeResult } from '../src/llm/types';
import type { YunseulSettings } from '../src/settings';

// ChatSession test harness. Drives the session against a stub LLMClient
// so we can exercise the orchestration contracts that are otherwise
// impossible to reach via the high-level happy path: pre-token onError,
// post-token onError, abort-before-first-token, and the userMsgCommitted
// vs firstTokenReceived two-tier latch from audit finding #7.
//
// We do NOT spin up the real LMClient/ClaudeCodeClient — those have their
// own dedicated tests. We pass a fake LLMClient whose `streamChat` is a
// driver hook the test owns end-to-end.

interface FakeLLMClient extends LLMClient {
	/** Last received opts so the test can inspect or invoke callbacks. */
	lastOpts: StreamChatOpts | null;
}

function makeFakeClient(driver: (opts: StreamChatOpts) => Promise<void>): FakeLLMClient {
	const client: FakeLLMClient = {
		lastOpts: null,
		listModels: async (): Promise<string[]> => [],
		probe: async (): Promise<ProbeResult> => ({ ok: true, kind: 'ok', message: 'ok' }),
		streamChat: async (opts: StreamChatOpts): Promise<void> => {
			client.lastOpts = opts;
			await driver(opts);
		},
	};
	return client;
}

/**
 * Test-only flat overrides accepted by makeSettings. The session
 * tests historically only flipped `provider` and (rarely) the
 * lmStudio-side knobs, so we accept either a top-level Provider
 * override or a nested-shape Partial<YunseulSettings> and merge
 * over the grouped defaults.
 */
function makeSettings(overrides: Partial<YunseulSettings> = {}): YunseulSettings {
	const base: YunseulSettings = {
		schemaVersion: 1,
		provider: 'lm-studio',
		lmStudio: {
			baseUrl: 'http://localhost:1234/v1',
			apiKey: '',
			chatModel: 'test-model',
			temperature: 0.7,
			maxContextChars: 12000,
			maxConversationRounds: 10,
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
	return {
		...base,
		...overrides,
		lmStudio: { ...base.lmStudio, ...(overrides.lmStudio ?? {}) },
		claudeCode: { ...base.claudeCode, ...(overrides.claudeCode ?? {}) },
		chat: { ...base.chat, ...(overrides.chat ?? {}) },
		index: { ...base.index, ...(overrides.index ?? {}) },
		privacy: { ...base.privacy, ...(overrides.privacy ?? {}) },
	};
}

interface StubPlugin {
	settings: YunseulSettings;
	lmClient: FakeLLMClient;
	retriever: null;
	logger: { debug: (...a: unknown[]) => void; info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
	app: { vault: { cachedRead: (file: { path: string }) => Promise<string> } };
	persistCount: number;
	persistSession: (s: ChatSession) => void;
}

function makePlugin(
	client: FakeLLMClient,
	settingsOverrides?: Partial<YunseulSettings>,
): StubPlugin {
	const plugin: StubPlugin = {
		settings: makeSettings(settingsOverrides),
		lmClient: client,
		retriever: null,
		logger: {
			debug: (): void => {},
			info: (): void => {},
			warn: (): void => {},
			error: (): void => {},
		},
		app: {
			vault: {
				cachedRead: async (): Promise<string> => '',
			},
		},
		persistCount: 0,
		persistSession: function (this: StubPlugin): void {
			this.persistCount += 1;
		},
	};
	plugin.persistSession = plugin.persistSession.bind(plugin);
	return plugin;
}

interface SendOutcome {
	tokens: string[];
	completed: boolean;
	completedMeta: StreamCompletionMeta | undefined;
	errored: Error | null;
}

function makeSendCtx(): SendOutcome & {
	onToken: (t: string) => void;
	onComplete: (meta?: StreamCompletionMeta) => void;
	onError: (err: Error) => void;
} {
	const outcome: SendOutcome = {
		tokens: [],
		completed: false,
		completedMeta: undefined,
		errored: null,
	};
	return {
		...outcome,
		onToken: function (this: typeof outcome, t: string): void {
			this.tokens.push(t);
		}.bind(outcome),
		onComplete: function (this: typeof outcome, meta?: StreamCompletionMeta): void {
			this.completed = true;
			this.completedMeta = meta;
		}.bind(outcome),
		onError: function (this: typeof outcome, err: Error): void {
			this.errored = err;
		}.bind(outcome),
		get tokens(): string[] {
			return outcome.tokens;
		},
		get completed(): boolean {
			return outcome.completed;
		},
		get completedMeta(): StreamCompletionMeta | undefined {
			return outcome.completedMeta;
		},
		get errored(): Error | null {
			return outcome.errored;
		},
	};
}

describe('ChatSession.send — happy path', () => {
	it('streams tokens through to the bubble and commits the user + assistant turn to history', async () => {
		const client = makeFakeClient(async (opts) => {
			opts.onToken('hello');
			opts.onToken(' world');
			opts.onComplete();
		});
		const plugin = makePlugin(client);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const session = new ChatSession(plugin as any);
		const ctx = makeSendCtx();

		await session.send('say hi', {
			boundFileExcerpt: null,
			onToken: ctx.onToken,
			onComplete: ctx.onComplete,
			onError: ctx.onError,
		});

		expect(ctx.tokens).toEqual(['hello', ' world']);
		expect(ctx.completed).toBe(true);
		expect(ctx.errored).toBeNull();
		expect(session.history).toHaveLength(2);
		expect(session.history[0]?.role).toBe('user');
		expect(session.history[0]?.content).toBe('say hi');
		expect(session.history[1]?.role).toBe('assistant');
		expect(session.history[1]?.content).toBe('hello world');
		expect(session.isStreaming()).toBe(false);
	});
});

describe('ChatSession.send — pre-token error (audit finding #7)', () => {
	it('clears claudeCodeSessionId and rolls back the user msg when neither onMeta nor onToken fired', async () => {
		const client = makeFakeClient(async (opts) => {
			// Subprocess died before init — no meta, no token.
			opts.onError(new Error('spawn ENOENT'));
		});
		const plugin = makePlugin(client, { provider: 'claude-code' });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const session = new ChatSession(plugin as any);
		session.claudeCodeSessionId = 'pre-existing-id';
		const ctx = makeSendCtx();

		await session.send('hello', {
			boundFileExcerpt: null,
			onToken: ctx.onToken,
			onComplete: ctx.onComplete,
			onError: ctx.onError,
		});

		expect(ctx.errored).not.toBeNull();
		expect(ctx.completed).toBe(false);
		expect(session.history).toHaveLength(0);
		// No onMeta fired → no evidence the CLI accepted the input → clear
		// the session id AND roll back the user msg.
		expect(session.claudeCodeSessionId).toBeNull();
	});

	it('clears claudeCodeSessionId but keeps the user msg when onMeta fired before onError', async () => {
		// Pinned to audit finding #7. system/init fired (the CLI captured
		// the input and assigned a server-side session id) but the
		// subprocess crashed before producing any tokens. The user msg
		// must stay committed (we DO have evidence the round-trip
		// reached the model) but claudeCodeSessionId must be cleared
		// so the next send mints a fresh server-side session instead
		// of `--resume`-ing a half-state one.
		const client = makeFakeClient(async (opts) => {
			opts.onMeta?.({ sessionId: 'sess-from-init' });
			opts.onError(new Error('subprocess crashed mid-init'));
		});
		const plugin = makePlugin(client, { provider: 'claude-code' });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const session = new ChatSession(plugin as any);
		const ctx = makeSendCtx();

		await session.send('hello', {
			boundFileExcerpt: null,
			onToken: ctx.onToken,
			onComplete: ctx.onComplete,
			onError: ctx.onError,
		});

		expect(ctx.errored).not.toBeNull();
		expect(ctx.tokens).toEqual([]);
		// User msg committed because onMeta proved the CLI accepted us.
		expect(session.history).toHaveLength(1);
		expect(session.history[0]?.role).toBe('user');
		// Session id cleared because no token arrived to anchor it.
		expect(session.claudeCodeSessionId).toBeNull();
	});
});

describe('ChatSession.send — pre-token abort', () => {
	it('clears claudeCodeSessionId on abort if no token arrived (even when system/init fired)', async () => {
		// session.stop() can only be called once the session has an
		// active abortCtrl (created on send entry); we drive the abort
		// from inside the streamChat driver after onMeta runs, before
		// any token, and resolve through onComplete to match the
		// documented LMClient + ClaudeCodeClient behavior (aborts
		// complete, they don't error).
		let sessionRef: ChatSession | null = null;
		const client = makeFakeClient(async (opts) => {
			opts.onMeta?.({ sessionId: 'sess-from-init' });
			sessionRef?.stop(); // sets signal.aborted = true
			opts.onComplete();
		});
		const plugin = makePlugin(client, { provider: 'claude-code' });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const session = new ChatSession(plugin as any);
		sessionRef = session;
		const ctx = makeSendCtx();

		await session.send('hello', {
			boundFileExcerpt: null,
			onToken: ctx.onToken,
			onComplete: ctx.onComplete,
			onError: ctx.onError,
		});

		expect(ctx.completed).toBe(true);
		expect(ctx.tokens).toEqual([]);
		// Pre-token abort → clear the session id.
		expect(session.claudeCodeSessionId).toBeNull();
	});
});

describe('ChatSession.send — post-token error', () => {
	it('preserves partial assistant content and KEEPS claudeCodeSessionId when error arrives after first token', async () => {
		const client = makeFakeClient(async (opts) => {
			opts.onMeta?.({ sessionId: 'sess-from-init' });
			opts.onToken('partial ');
			opts.onToken('reply');
			// Stream succeeded enough to anchor the session — a mid-stream
			// failure should NOT discard the server-side session id.
			opts.onError(new Error('socket dropped'));
		});
		const plugin = makePlugin(client, { provider: 'claude-code' });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const session = new ChatSession(plugin as any);
		const ctx = makeSendCtx();

		await session.send('hello', {
			boundFileExcerpt: null,
			onToken: ctx.onToken,
			onComplete: ctx.onComplete,
			onError: ctx.onError,
		});

		expect(ctx.errored).not.toBeNull();
		expect(ctx.tokens).toEqual(['partial ', 'reply']);
		// User msg + assistant msg both preserved.
		expect(session.history).toHaveLength(2);
		expect(session.history[0]?.role).toBe('user');
		expect(session.history[1]?.role).toBe('assistant');
		expect(session.history[1]?.content).toBe('partial reply');
		// Server-side session is recoverable; keep the id so the next
		// send can --resume from the captured init point.
		expect(session.claudeCodeSessionId).toBe('sess-from-init');
	});
});
