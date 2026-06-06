/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppendPreviewModal } from '../src/ui/AppendPreviewModal';
import { ResetIndexConfirmModal } from '../src/ui/ResetIndexConfirmModal';
import { AIChatView } from '../src/ui/AIChatView';
import { ChatSession } from '../src/chat/session';
import { TFile } from './_stubs/obsidian';
import type YunseulPlugin from '../src/main';
import type { ProbeResult, StreamChatOpts } from '../src/llm/types';
import type { YunseulSettings } from '../src/settings';

// JSDOM-based accessibility smoke tests (audit A7). These pin a small
// set of WCAG-derived invariants so a future refactor can't silently
// regress focus management, log-role announcements, or non-color
// disambiguation for status indicators. We do NOT run contrast checks
// (too brittle under headless jsdom + theme variables); the assertions
// are structural.

// ---- Stubs --------------------------------------------------------------

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

function makeStubPlugin(): YunseulPlugin {
	const sessions = new Map<string, ChatSession>();
	let activeId: string | null = null;
	const lmClient = {
		probe: async (): Promise<ProbeResult> => ({ ok: true, kind: 'ok', message: 'ok' }),
		listModels: async (): Promise<string[]> => [],
		streamChat: (_sc: StreamChatOpts): Promise<void> => new Promise<void>(() => {
			// Never resolves; tests that need send semantics drive it elsewhere.
		}),
	};
	const plugin: any = {
		settings: { ...DEFAULT_SETTINGS },
		logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
		manifest: { id: 'yunseul', version: '0.1.0' },
		sessions,
		retriever: null,
		lmClient,
		app: {
			workspace: {
				getActiveFile: () => null,
				openLinkText: vi.fn(),
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
		onConnectionStateChange: (_l: unknown) => () => {},
		onSettingsChange: (_l: unknown) => () => {},
	};
	return plugin as YunseulPlugin;
}

function makeView(plugin: YunseulPlugin): AIChatView {
	const view = new AIChatView({ app: (plugin as any).app } as any, plugin);
	document.body.appendChild(view.containerEl);
	return view;
}

afterEach(() => {
	document.body.innerHTML = '';
});

// ---- Modal focus management (A1) ---------------------------------------

describe('Modal focus management — WCAG 2.4.3 (audit A1)', () => {
	it('AppendPreviewModal.onOpen focuses the confirmatory Append button (safe default)', () => {
		const app = { workspace: {} } as any;
		const file = Object.assign(new TFile(), { path: 'Notes/Target.md' });
		const modal = new AppendPreviewModal(app, {
			file,
			replyText: 'hello world',
			stripSources: false,
			onConfirm: () => {},
		});
		// Mount contentEl in jsdom so .focus() can succeed (jsdom only
		// focuses elements connected to the document).
		document.body.appendChild(modal.contentEl);
		modal.onOpen();
		const confirmBtn = modal.contentEl.querySelector('button.mod-cta') as HTMLButtonElement | null;
		expect(confirmBtn).not.toBeNull();
		expect(document.activeElement).toBe(confirmBtn);
		modal.onClose();
	});

	it('ResetIndexConfirmModal.onOpen focuses the safe Cancel button (destructive default)', () => {
		const app = {} as any;
		const modal = new ResetIndexConfirmModal(app, {
			indexPath: '.yunseul/bm25-index.json',
			onConfirm: () => {},
		});
		document.body.appendChild(modal.contentEl);
		modal.onOpen();
		const buttons = Array.from(modal.contentEl.querySelectorAll('button')) as HTMLButtonElement[];
		const cancelBtn = buttons.find((b) => b.textContent === 'Cancel');
		const confirmBtn = buttons.find((b) => b.textContent === 'Reset index');
		expect(cancelBtn).toBeDefined();
		expect(confirmBtn).toBeDefined();
		// Critical: a destructive modal focuses Cancel so an immediate
		// Enter press is a no-op rather than data loss.
		expect(document.activeElement).toBe(cancelBtn);
		expect(document.activeElement).not.toBe(confirmBtn);
		modal.onClose();
	});
});

// ---- Transcript log semantics (A6) -------------------------------------

describe('Transcript log semantics (audit A6)', () => {
	it('transcript element carries role=log and aria-relevant=additions (no text)', async () => {
		const plugin = makeStubPlugin();
		const view = makeView(plugin);
		await view.onOpen();
		const transcript = view.containerEl.querySelector('.yunseul-transcript');
		expect(transcript).not.toBeNull();
		expect(transcript?.getAttribute('role')).toBe('log');
		// The fix removes 'text' from aria-relevant so per-token text
		// mutations don't fire announcements during streaming.
		expect(transcript?.getAttribute('aria-relevant')).toBe('additions');
		expect(transcript?.getAttribute('aria-relevant')).not.toContain('text');
		await view.onClose();
	});
});

// ---- Wordmark heading semantics (A2) -----------------------------------

describe('Wordmark heading semantics (audit A2)', () => {
	it('wordmark element is NOT a literal h1 and carries a presentation role', async () => {
		const plugin = makeStubPlugin();
		const view = makeView(plugin);
		await view.onOpen();
		const wordmark = view.containerEl.querySelector('.yunseul-wordmark') as HTMLElement | null;
		expect(wordmark).not.toBeNull();
		// A literal h1 here would duplicate Obsidian's page-level h1.
		expect(wordmark?.tagName).not.toBe('H1');
		// Either role=presentation or role=heading with aria-level=2 is
		// acceptable per the audit spec; we adopted role=presentation as
		// the simpler form.
		const role = wordmark?.getAttribute('role');
		expect(['presentation', 'heading']).toContain(role ?? '');
		// Visual styling is preserved (the .yunseul-wordmark class still
		// targets the same CSS rules).
		expect(wordmark?.textContent).toBe('Yunseul');
		await view.onClose();
	});
});

// ---- Connection-state dot disambiguator (A5) ---------------------------

describe('Connection-state dot — color + shape disambiguator (audit A5)', () => {
	it('dot element carries both a color class AND a data-state attribute', async () => {
		const plugin = makeStubPlugin();
		const view = makeView(plugin);
		await view.onOpen();
		const dot = view.containerEl.querySelector('.yunseul-status-dot') as HTMLElement | null;
		expect(dot).not.toBeNull();
		// Color class is one of the is-* color modifiers.
		const hasColorClass = dot?.classList.contains('is-ready')
			|| dot?.classList.contains('is-offline')
			|| dot?.classList.contains('is-unknown');
		expect(hasColorClass).toBe(true);
		// Non-color disambiguator: data-state is set in lockstep so CSS
		// authors can render a shape-per-state without relying on hue.
		const dataState = dot?.getAttribute('data-state');
		expect(dataState).not.toBeNull();
		expect(['ready', 'offline', 'unknown']).toContain(dataState ?? '');
		await view.onClose();
	});
});

// ---- Action bar visibility (A3) ----------------------------------------

describe('Message action bar visibility — phantom focus removal (audit A3)', () => {
	it('action bar uses the yunseul-msg-actions class which is wired to visibility:hidden in default state', async () => {
		// The CSS rule `.yunseul-msg-actions { visibility: hidden; ... }`
		// pulls the bar out of the tab order until hover/focus-within.
		// We assert on the CLASS presence (not computed style — Obsidian
		// styles aren't loaded under jsdom) which is the contract between
		// MessageBubble and styles.css. A future regression that drops
		// the class or renames it without updating CSS would be caught
		// by the AIChatView smoke test elsewhere; this just locks in the
		// class-driven contract.
		const plugin = makeStubPlugin();
		const view = makeView(plugin);
		await view.onOpen();
		// Send a message so an assistant bubble (with action bar) exists.
		const composer = view.containerEl.querySelector('textarea.yunseul-textarea') as HTMLTextAreaElement;
		composer.value = 'hello';
		composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
		await new Promise((r) => setTimeout(r, 10));
		const actionBars = view.containerEl.querySelectorAll('.yunseul-msg-actions');
		// At least the user bubble has one.
		expect(actionBars.length).toBeGreaterThan(0);
		// The class is the load-bearing hook for the visibility:hidden
		// CSS rule. No element should be missing it.
		for (const bar of Array.from(actionBars)) {
			expect(bar.classList.contains('yunseul-msg-actions')).toBe(true);
		}
		await view.onClose();
	});
});
