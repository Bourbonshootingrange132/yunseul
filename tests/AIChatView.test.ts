/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AIChatView } from '../src/ui/AIChatView';
import { ChatSession } from '../src/chat/session';
import type YunseulPlugin from '../src/main';
import type { StreamChatOpts, ProbeResult, StreamCompletionMeta } from '../src/llm/types';
import type { YunseulSettings } from '../src/settings';
import { TFile } from './_stubs/obsidian';

// JSDOM smoke test for the AIChatView orchestrator extracted in V1.3.
// We build a comprehensive stub plugin so production code stays untouched;
// the View takes the plugin via constructor and exercises a handful of
// well-defined hooks. The LLMClient is a driver the test owns so we can
// synthesize tokens / aborts / completes from outside.

interface StreamHandles {
	emitToken: (t: string) => void;
	emitMeta: (m: StreamCompletionMeta) => void;
	emitComplete: (m?: StreamCompletionMeta) => void;
	emitError: (e: Error) => void;
	signal: AbortSignal;
}

const DEFAULT_SETTINGS: YunseulSettings = {
	schemaVersion: 1,
	provider: 'lm-studio',
	lmStudio: {
		baseUrl: 'http://x', apiKey: '', chatModel: 'm', temperature: 0.7,
		maxContextChars: 12000, maxConversationRounds: 10,
	},
	claudeCode: { binary: '', modelOverride: '', enableWrites: false },
	chat: {
		suggestions: ['Summarize this note', 'Find related notes'],
		downloadFolder: 'AI Chats',
	},
	index: { enabled: false, topK: 8, excludeTags: [], promptState: 'unanswered' },
	privacy: { allowExternalImages: false, treatClippingsAsUntrusted: true, clippingsFolder: 'Clippings' },
	debug: false,
};

function makeStub(opts?: { handles?: StreamHandles; retriever?: any }): {
	plugin: YunseulPlugin;
	openLinkText: ReturnType<typeof vi.fn>;
	connectionListeners: Set<(s: string) => void>;
} {
	const sessions = new Map<string, ChatSession>();
	const connectionListeners = new Set<(s: string) => void>();
	const settingsListeners = new Set<() => void>();
	const openLinkText = vi.fn();
	let activeId: string | null = null;

	const lmClient = {
		probe: async (): Promise<ProbeResult> => ({ ok: true, kind: 'ok', message: 'ok' }),
		listModels: async (): Promise<string[]> => [],
		// Pending Promise so isStreaming() stays true until the test calls
		// emitComplete/emitError. session.send's abortCtrl is bound to this
		// Promise's lifetime.
		streamChat: (sc: StreamChatOpts): Promise<void> => new Promise<void>((resolve) => {
			if (opts?.handles === undefined) return;
			const h = opts.handles;
			h.emitToken = sc.onToken;
			h.emitMeta = (m): void => sc.onMeta?.(m);
			h.emitComplete = (m): void => { sc.onComplete(m); resolve(); };
			h.emitError = (e): void => { sc.onError(e); resolve(); };
			Object.defineProperty(h, 'signal', { value: sc.signal, configurable: true });
		}),
	};

	const plugin: any = {
		settings: { ...DEFAULT_SETTINGS },
		logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
		manifest: { id: 'yunseul', version: '0.1.0' },
		sessions,
		retriever: opts?.retriever ?? null,
		lmClient,
		app: {
			workspace: {
				getActiveFile: () => null,
				openLinkText,
				getLeaf: () => ({ openFile: async () => {} }),
			},
			vault: {
				cachedRead: vi.fn(async () => ''),
				getAbstractFileByPath: vi.fn(() => null),
				adapter: { exists: async () => false, write: async () => {} },
			},
		},
		getOrCreateActiveSessionId(): string {
			if (activeId !== null && sessions.has(activeId)) return activeId;
			return plugin.createSession();
		},
		createSession(): string {
			const s = new ChatSession(plugin as YunseulPlugin);
			sessions.set(s.id, s);
			activeId = s.id;
			return s.id;
		},
		setActiveSessionId: (id: string) => { activeId = id; },
		persistSession: vi.fn(),
		getConnectionState: () => ({ state: 'ready' }),
		updateConnectionState: vi.fn(),
		onConnectionStateChange: (l: (s: string) => void) => {
			connectionListeners.add(l);
			return () => { connectionListeners.delete(l); };
		},
		onSettingsChange: (l: () => void) => {
			settingsListeners.add(l);
			return () => { settingsListeners.delete(l); };
		},
	};

	return { plugin: plugin as YunseulPlugin, openLinkText, connectionListeners };
}

function makeView(plugin: YunseulPlugin): AIChatView {
	// Cast leaf to any — only the stubbed ItemView constructor reads .app off it.
	const view = new AIChatView({ app: (plugin as any).app } as any, plugin);
	document.body.appendChild(view.containerEl);
	return view;
}

const microtasks = async (n = 2): Promise<void> => {
	for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

const triggerEnter = (input: HTMLTextAreaElement): void => {
	input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
};

const getInput = (view: AIChatView): HTMLTextAreaElement =>
	view.containerEl.querySelector('textarea.yunseul-textarea') as HTMLTextAreaElement;

afterEach(() => {
	document.body.innerHTML = '';
	vi.useRealTimers();
});

describe('AIChatView — mount + empty state', () => {
	it('renders the empty-state tagline on first mount', async () => {
		const { plugin } = makeStub();
		const view = makeView(plugin);
		await view.onOpen();
		const empty = view.containerEl.querySelector('.yunseul-empty');
		expect(empty).not.toBeNull();
		expect(view.containerEl.querySelector('.yunseul-empty-tagline')?.textContent)
			.toContain('Where your notes catch the light.');
		await view.onClose();
	});
});

describe('AIChatView — send → user bubble rendered', () => {
	it('appends a role=user bubble when the composer triggers send via Enter', async () => {
		const handles = {} as StreamHandles;
		const { plugin } = makeStub({ handles });
		const view = makeView(plugin);
		await view.onOpen();

		const input = getInput(view);
		expect(input).not.toBeNull();
		input.value = 'hello';
		// Real Enter keydown — the composer's registerDomEvent('keydown', …)
		// handler funnels through handleSendOrStop.
		triggerEnter(input);
		await microtasks();

		const userBubble = view.containerEl.querySelector('.yunseul-msg.yunseul-msg-user');
		expect(userBubble).not.toBeNull();
		expect(userBubble?.textContent).toContain('hello');

		handles.emitComplete?.();
		await microtasks();
		await view.onClose();
	});
});

describe('AIChatView — streaming token text + final markdown render', () => {
	it('shows token text during stream and re-renders as markdown on completion', async () => {
		const handles = {} as StreamHandles;
		const { plugin } = makeStub({ handles });
		const view = makeView(plugin);
		await view.onOpen();

		const input = getInput(view);
		input.value = 'streaming check';
		triggerEnter(input);
		await microtasks();

		handles.emitToken('Hel');
		handles.emitToken('lo');
		// SendController's 33ms throttle — flush.
		await new Promise((r) => setTimeout(r, 60));

		const assistant = view.containerEl.querySelector('.yunseul-msg.yunseul-msg-assistant');
		expect(assistant).not.toBeNull();
		const body = assistant?.querySelector('.yunseul-msg-body');
		// Two-phase render: text node holds 'Hello' BEFORE the final phase
		// runs MarkdownRenderer.
		expect(body?.textContent).toContain('Hello');
		expect(body?.querySelector('.markdown-rendered')).toBeNull();

		handles.emitComplete?.();
		await microtasks();

		const rendered = assistant?.querySelector('.markdown-rendered');
		expect(rendered).not.toBeNull();
		expect(rendered?.textContent).toContain('Hello');
		await view.onClose();
	});
});

describe('AIChatView — sources click → openLinkText invoked', () => {
	it('routes a click on a .internal-link inside the sources block through workspace.openLinkText', async () => {
		const handles = {} as StreamHandles;
		// Retriever stub: returns one hit; session.maybeRetrieve forwards it
		// to session.lastRetrieval, which SendController consumes inside
		// onComplete to render the sources block.
		const hitFile = Object.assign(new TFile(), { path: 'Notes/Widget.md', basename: 'Widget' });
		const retriever = {
			search: vi.fn(() => [{ file: hitFile, score: 0.8, matchedTerms: ['widgets'] }]),
		};
		const { plugin, openLinkText } = makeStub({ handles, retriever });
		(plugin as any).settings.index.enabled = true;
		const view = makeView(plugin);
		await view.onOpen();

		const input = getInput(view);
		input.value = 'find related notes about widgets';
		triggerEnter(input);
		await microtasks();

		handles.emitToken('answer body');
		await new Promise((r) => setTimeout(r, 60));
		handles.emitComplete?.();
		await microtasks();

		const link = view.containerEl.querySelector('a.internal-link') as HTMLAnchorElement | null;
		expect(link).not.toBeNull();
		link?.click();
		expect(openLinkText).toHaveBeenCalledTimes(1);
		expect(openLinkText.mock.calls[0]?.[0]).toBe('Notes/Widget');
		await view.onClose();
	});
});

describe('AIChatView — New chat stops in-flight stream', () => {
	it('calls session.stop() on the streaming session BEFORE creating the next one (V1.3 fix)', async () => {
		const handles = {} as StreamHandles;
		const { plugin } = makeStub({ handles });
		const view = makeView(plugin);
		await view.onOpen();

		const input = getInput(view);
		input.value = 'streaming-then-new';
		triggerEnter(input);
		await microtasks();
		handles.emitToken('partial');
		await microtasks(1);

		const streaming = Array.from(plugin.sessions.values()).find((s) => s.isStreaming());
		expect(streaming).toBeDefined();
		const stopSpy = vi.spyOn(streaming!, 'stop');
		const createSpy = vi.spyOn(plugin as any, 'createSession');

		const newBtn = Array.from(view.containerEl.querySelectorAll('button.yunseul-header-btn'))
			.find((b) => b.textContent === 'New') as HTMLButtonElement | undefined;
		newBtn?.click();
		await microtasks();

		expect(stopSpy).toHaveBeenCalledTimes(1);
		expect(createSpy).toHaveBeenCalledTimes(1);
		// Strict ordering: stop's invocationCallOrder < createSession's.
		const stopOrder = stopSpy.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER;
		const createOrder = createSpy.mock.invocationCallOrder[0] ?? 0;
		expect(stopOrder).toBeLessThan(createOrder);

		handles.emitComplete?.();
		await microtasks();
		await view.onClose();
	});
});

describe('AIChatView — onClose cleanup', () => {
	beforeEach(() => { vi.useFakeTimers(); });

	it('invokes connectionUnsub and leaves no dangling view-owned intervals', async () => {
		const { plugin, connectionListeners } = makeStub();
		const view = makeView(plugin);
		await view.onOpen();

		expect(connectionListeners.size).toBe(1);

		// Drain the one-shot jsdom-internal timer scheduled by
		// textarea.focus() inside onOpen (Selection._associateRange).
		// It is NOT view-owned and must not muddy the strict assertion.
		vi.advanceTimersByTime(0);
		await view.onClose();

		expect(connectionListeners.size).toBe(0);
		// The composer's send-button interval and MessageBubble's prefill
		// interval are bound to the view's Component lifecycle; both must
		// be cleared by now.
		expect(vi.getTimerCount()).toBe(0);
	});
});
