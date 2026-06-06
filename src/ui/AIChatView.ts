import {
	type IconName,
	ItemView,
	Notice,
	type WorkspaceLeaf,
} from 'obsidian';
import type YunseulPlugin from '../main';
import type { ChatSession } from '../chat/session';
import { renderMessageBubble } from './MessageBubble';
import type { ThrottledFn } from '../util/throttle';
import {
	type ClipboardAdapter,
	copyAll as exporterCopyAll,
	downloadConversation as exporterDownload,
} from './ChatExporter';
import {
	type SourcesBlockHost,
	type SourcesKey,
} from './SourcesBlock';
import { renderEmptyState, type EmptyStateHandle } from './EmptyState';
import { handleAppend } from './AppendFlow';
import { renderChatHeader, type ChatHeaderHandle } from './ChatHeader';
import { renderChatComposer, type ChatComposerHandle } from './ChatComposer';
import {
	buildBoundFileExcerpt,
	runSend,
	type SendControllerHost,
} from './SendController';

export const VIEW_TYPE_AI_CHAT = 'yunseul-chat';

type Unsub = () => void;

export class AIChatView extends ItemView {
	private readonly plugin: YunseulPlugin;
	private transcriptEl: HTMLDivElement | null = null;
	// Per-view randomized id so two open leaves don't collide on the
	// slash-hint aria-describedby relationship.
	private slashHintId: string = '';
	private motionMql: MediaQueryList | null = null;
	private motionListener: ((ev: MediaQueryListEvent) => void) | null = null;
	private activeSessionId: string | null = null;
	private connectionUnsub: Unsub | null = null;
	private settingsUnsub: Unsub | null = null;
	private previousFocus: HTMLElement | null = null;
	private sending = false;
	private activeThrottle: ThrottledFn<[string]> | null = null;
	private emptyStateHandle: EmptyStateHandle | null = null;
	private headerHandle: ChatHeaderHandle | null = null;
	private composerHandle: ChatComposerHandle | null = null;
	// Per-view-lifetime collapse state for the SOURCES block. SourcesKey
	// already encodes sessionId, so the flat shape covers all sessions
	// without nesting bugs. Cleared in onClose.
	private sourcesCollapsed = new Map<SourcesKey, boolean>();

	private readonly sourcesHost: SourcesBlockHost = {
		component: this,
		getCollapsed: (key) => this.sourcesCollapsed.get(key) === true,
		setCollapsed: (key, c) => { this.sourcesCollapsed.set(key, c); },
	};

	private buildSendHost(): SendControllerHost {
		return {
			sourcesHost: this.sourcesHost,
			// Lazy getter so SendController always reads the LIVE element;
			// a future "clear transcript" command could recreate the
			// element and any captured-by-value reference would go stale.
			getTranscriptEl: () => this.transcriptEl,
			getAllowExternalImages: () => this.plugin.settings.privacy.allowExternalImages,
			getSourcePath: (s) => s.boundFile?.path ?? '',
			getModelLabel: () => this.headerHandle?.resolveModelLabel().visible,
			onCopy: (text) => void this.clipboardAdapter.write(text),
			onAppend: (s, text) => void handleAppend(this.app, this.plugin, s, text),
			scrollToBottom: () => this.scrollTranscriptToBottom(),
			setStreaming: (s) => this.setStreamingUI(s),
			setThrottle: (t) => { this.activeThrottle = t; },
			logger: this.plugin.logger,
		};
	}

	constructor(leaf: WorkspaceLeaf, plugin: YunseulPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string { return VIEW_TYPE_AI_CHAT; }
	getDisplayText(): string { return 'Chat'; }
	getIcon(): IconName { return 'sparkles'; }

	async onOpen(): Promise<void> {
		const doc = this.containerEl.ownerDocument;
		this.previousFocus = doc.activeElement instanceof HTMLElement ? doc.activeElement : null;
		// Reduced-motion subscription: previously gated a smooth-scroll
		// branch in scrollTranscriptToBottom that fought user scroll-up.
		// We now always use instant scroll (audit U3), so the listener
		// stays registered for future motion-sensitive call sites and
		// for parity with onClose's teardown order; the field reads are
		// removed but the subscription/teardown pair is preserved.
		this.motionMql = window.matchMedia('(prefers-reduced-motion: reduce)');
		this.motionListener = (_ev) => {
			// no-op — see note above
		};
		this.motionMql.addEventListener('change', this.motionListener);
		this.slashHintId = `yunseul-slash-hint-${Math.random().toString(36).slice(2, 10)}`;
		const root = this.contentEl;
		root.empty();
		root.addClass('yunseul-chat-root');

		// renderChatHeader inserts TWO siblings into root: bannerEl FIRST,
		// then the header region. DO NOT move banner ownership.
		this.headerHandle = renderChatHeader({
			root,
			component: this,
			plugin: this.plugin,
			onNewChat: () => void this.startNewSession(),
			onExport: () => void this.downloadConversation(),
			onCopyAll: () => void this.copyAll(),
			onRetryConnection: () => void this.retryConnection(),
			onBannerFocusEscaped: () => this.composerHandle?.focus(),
			getActiveSession: () => this.getActiveSession(),
		});
		this.renderTranscript(root);
		this.mountComposer(root);

		this.activeSessionId = this.plugin.getOrCreateActiveSessionId();
		const session = this.getActiveSession();
		if (session !== undefined) {
			this.renderHistoryFor(session);
			this.headerHandle.setStatus(session);
		}

		this.headerHandle.setConnectionState(this.plugin.getConnectionState());
		this.connectionUnsub = this.plugin.onConnectionStateChange(
			(state) => this.headerHandle?.setConnectionState(state),
		);
		this.settingsUnsub = this.plugin.onSettingsChange(() => {
			const s = this.getActiveSession();
			if (s !== undefined) this.headerHandle?.setStatus(s);
			this.composerHandle?.updateContextRow();
		});

		this.composerHandle?.focus();
	}

	private renderTranscript(root: HTMLElement): void {
		// `aria-relevant="additions"` — NOT `"additions text"`. The `text`
		// value makes screen readers re-announce on every text-content
		// mutation, which fires per token during streaming (audit A6).
		// The aria-busy on each bubble's article root (set in setThinking,
		// cleared in markComplete inside MessageBubble) ensures the bubble
		// is announced once when finalized rather than during assembly.
		this.transcriptEl = root.createDiv({
			cls: 'yunseul-transcript',
			attr: { role: 'log', 'aria-relevant': 'additions' },
		});
		this.registerDomEvent(this.transcriptEl, 'click', (ev) => this.handleInternalLinkClick(ev, false));
		this.registerDomEvent(this.transcriptEl, 'auxclick', (ev) => {
			if (ev.button === 1) this.handleInternalLinkClick(ev, true);
		});
	}

	private mountComposer(root: HTMLElement): void {
		this.composerHandle = renderChatComposer({
			root,
			component: this,
			plugin: this.plugin,
			slashHintId: this.slashHintId,
			getActiveSession: () => this.getActiveSession(),
			onSendOrStop: () => void this.handleSendOrStop(),
			onBindFile: () => this.handleBindFileClick(),
			onUnbindFile: () => {
				const s = this.getActiveSession();
				if (s === undefined) return;
				s.boundFile = null;
				this.headerHandle?.setStatus(s);
				this.composerHandle?.updateContextRow();
			},
			onPreviousFocus: () => this.previousFocus?.focus(),
		});
	}

	async onClose(): Promise<void> {
		// DESIGN: in-flight session streams INTENTIONALLY survive view
		// close — see chat/session.ts:28-32. The session owns no DOM
		// references, just the AbortController + history, so a leaf close
		// here doesn't cancel the LLM round-trip; the persisted tokens
		// land in session.history and replay when a new leaf opens the
		// same session. Do NOT add session.stop() here without updating
		// that contract too.
		this.activeThrottle?.cancel();
		this.connectionUnsub?.();
		this.settingsUnsub?.();
		if (this.motionMql !== null && this.motionListener !== null) {
			this.motionMql.removeEventListener('change', this.motionListener);
		}
		// Anchor focus restoration to the element's OWN document so a
		// popout-window close still finds it (activeDocument tracks the
		// currently-focused window, which may have shifted to main).
		if (
			this.previousFocus !== null &&
			this.previousFocus.ownerDocument.contains(this.previousFocus)
		) {
			this.previousFocus.focus();
		}
		this.activeThrottle = null;
		this.connectionUnsub = null;
		this.settingsUnsub = null;
		this.motionMql = null;
		this.motionListener = null;
		this.previousFocus = null;
		this.sourcesCollapsed.clear();
		this.contentEl.empty();
	}

	private getActiveSession(): ChatSession | undefined {
		return this.activeSessionId !== null
			? this.plugin.sessions.get(this.activeSessionId)
			: undefined;
	}

	private async retryConnection(): Promise<void> {
		const result = await this.plugin.lmClient.probe();
		this.plugin.updateConnectionState({
			state: result.ok ? 'ready' : 'offline',
			message: result.message,
			kind: result.kind,
		});
		new Notice(result.message);
	}

	private renderHistoryFor(session: ChatSession): void {
		const transcript = this.transcriptEl;
		if (transcript === null) return;
		// Null out the previous empty-state handle BEFORE we wipe the
		// transcript so stale unbind clicks can't hit a vanished subtree.
		this.emptyStateHandle = null;
		this.composerHandle?.setSlashHintDescribedBy(false);
		transcript.empty();
		this.headerHandle?.setStatus(session);
		if (session.history.length === 0) {
			this.mountEmptyState(session);
			return;
		}
		const sourcePath = session.boundFile?.path ?? '';
		const modelLabel = this.headerHandle?.resolveModelLabel().visible;
		for (const msg of session.history) {
			const handle = renderMessageBubble(transcript, msg, {
				app: this.app,
				component: this,
				sourcePath,
				isStreaming: false,
				allowExternalImages: this.plugin.settings.privacy.allowExternalImages,
				modelLabel,
				onCopy: (text) => void this.clipboardAdapter.write(text),
				onAppend: msg.role === 'assistant'
					? (text) => void handleAppend(this.app, this.plugin, session, text)
					: undefined,
			});
			void handle.updateContent(msg.content, { isFinal: true });
		}
		this.scrollTranscriptToBottom();
	}

	private mountEmptyState(session: ChatSession): void {
		if (this.transcriptEl === null) return;
		this.emptyStateHandle = renderEmptyState({
			container: this.transcriptEl,
			component: this,
			session,
			suggestions: this.plugin.settings.chat.suggestions,
			pluginVersion: this.plugin.manifest.version,
			slashHintId: this.slashHintId,
			// Logo lives at <plugin-dir>/assets/logo.png. getResourcePath()
			// returns a webview-safe `app://` URL that the renderer is
			// allowed to fetch. Falls back to null if the adapter is the
			// non-FileSystem variant (mobile), in which case the empty
			// state just renders without the brand mark.
			logoUrl: this.resolveLogoUrl(),
			onSuggestionPick: (text) => this.applySuggestion(text),
			onUnbindBoundFile: () => {
				// CONTRACT (EmptyState.ts): all four side effects in order.
				session.boundFile = null;
				this.renderHistoryFor(session);
				this.headerHandle?.setStatus(session);
				this.composerHandle?.updateContextRow();
			},
		});
		// CONTRACT (EmptyState.ts): orchestrator owns the aria-describedby
		// wiring, set immediately after renderEmptyState and removed at
		// renderHistoryFor / send so the attr never dangles.
		this.composerHandle?.setSlashHintDescribedBy(true);
	}

	private resolveLogoUrl(): string | null {
		// Resolve assets/logo.png as a webview-safe URL. Path is relative
		// to the vault root: `.obsidian/plugins/<id>/assets/logo.png`.
		// Using the plugin's manifest.dir keeps this id-rename-safe.
		const dir = this.plugin.manifest.dir;
		if (dir === undefined || dir === '') return null;
		const rel = `${dir}/assets/logo.png`;
		try {
			return this.app.vault.adapter.getResourcePath(rel);
		} catch {
			return null;
		}
	}

	private applySuggestion(text: string): void {
		const c = this.composerHandle;
		if (c === null) return;
		c.setValue(text);
		c.focus();
		c.resize();
		c.frameEl.toggleClass('is-typing', c.getValue().length > 0);
		c.updateContextRow();
	}

	private async handleSendOrStop(): Promise<void> {
		const session = this.getActiveSession();
		if (session === undefined) return;
		if (session.isStreaming()) { session.stop(); return; }
		if (this.sending) return;
		this.sending = true;
		try {
			const composer = this.composerHandle;
			const text = composer?.getValue() ?? '';
			if (text.trim().length === 0) return;
			if (composer !== null) {
				composer.setValue('');
				composer.resize();
				composer.frameEl.removeClass('is-typing');
			}
			if (this.emptyStateHandle !== null) {
				composer?.setSlashHintDescribedBy(false);
				this.emptyStateHandle.remove();
				this.emptyStateHandle = null;
			}
			// Bind active file on first send when nothing is bound yet.
			if (session.boundFile === null) {
				const af = this.app.workspace.getActiveFile();
				if (af !== null) {
					session.boundFile = af;
					this.headerHandle?.setStatus(session);
				}
			}
			// Snapshot boundFile BEFORE buildBoundFileExcerpt so we can
			// detect the "bound file vanished" side effect (excerpt clears
			// session.boundFile to null) and refresh the header + composer
			// context row, which otherwise keep showing the stale binding
			// until the next setSettingsChange / unbind tick.
			const boundBefore = session.boundFile;
			const excerpt = await buildBoundFileExcerpt(this.app, this.plugin, session);
			if (boundBefore !== null && session.boundFile === null) {
				this.headerHandle?.setStatus(session);
				this.composerHandle?.updateContextRow();
			}
			if (session.isStreaming()) return;
			await runSend({
				app: this.app,
				plugin: this.plugin,
				session,
				text,
				excerpt,
				host: this.buildSendHost(),
			});
		} finally {
			this.sending = false;
		}
	}

	// Single orchestrator entry point fans streaming UI state out to BOTH
	// composer send button AND header dot pulse. Every toggle goes through
	// here so the two surfaces can't drift. Search anchor for auditors.
	private setStreamingUI(streaming: boolean): void {
		this.composerHandle?.setSendButtonStreaming(streaming);
		this.headerHandle?.setStreamingPulse(streaming);
	}

	private scrollTranscriptToBottom(): void {
		const t = this.transcriptEl;
		if (t === null) return;
		// Respect user scroll-up: if the user has scrolled away from the
		// bottom to read an earlier message, don't fight them with a
		// forced auto-scroll on every streaming tick. We resume auto-
		// scroll the moment the user scrolls back within the threshold.
		// Use INSTANT scroll (no behavior:'smooth') because smooth on
		// every 33ms tick is wasted CPU and adds visual fight; the human
		// already perceives the stream as continuous from the textContent
		// mutation rate.
		if (!isNearBottom(t)) return;
		t.scrollTop = t.scrollHeight;
	}

	private handleBindFileClick(): void {
		const s = this.getActiveSession();
		if (s === undefined) return;
		const af = this.app.workspace.getActiveFile();
		if (af === null) {
			new Notice('Open a note in the main pane first, then click to bind it.');
			return;
		}
		s.boundFile = af;
		this.headerHandle?.setStatus(s);
		this.composerHandle?.updateContextRow();
		new Notice(`Bound ${af.basename}`);
	}

	private readonly clipboardAdapter: ClipboardAdapter = {
		write: async (text) => {
			try {
				await navigator.clipboard.writeText(text);
				new Notice('Copied');
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				this.plugin.logger.error(`Clipboard write failed: ${msg}`, 'Copy failed.');
			}
		},
	};

	private async copyAll(): Promise<void> {
		const s = this.getActiveSession();
		if (s !== undefined) await exporterCopyAll(s, this.clipboardAdapter);
	}

	private async downloadConversation(): Promise<void> {
		const s = this.getActiveSession();
		if (s !== undefined) await exporterDownload(this.app, this.plugin, s);
	}

	private async startNewSession(): Promise<void> {
		// Required invariant: every code path that swaps the active session
		// MUST stop a streaming session first and reset the streaming UI
		// via setStreamingUI(false). Mirrors YunseulPlugin.rebuildLLMClient.
		const current = this.getActiveSession();
		if (current !== undefined && current.isStreaming()) {
			current.stop();
			this.activeThrottle?.cancel();
			this.activeThrottle = null;
			this.setStreamingUI(false);
			this.sending = false;
			new Notice('Previous reply cancelled — starting new session.');
		}
		const newId = this.plugin.createSession();
		this.activeSessionId = newId;
		this.plugin.setActiveSessionId(newId);
		const session = this.plugin.sessions.get(newId);
		if (session !== undefined) {
			this.renderHistoryFor(session);
			this.headerHandle?.setStatus(session);
			this.composerHandle?.updateContextRow();
		}
		this.composerHandle?.focus();
	}

	private handleInternalLinkClick(ev: MouseEvent, forceNewPane: boolean): void {
		const target = ev.target instanceof HTMLElement ? ev.target : null;
		const linkEl = target?.closest('a.internal-link');
		if (!(linkEl instanceof HTMLElement)) return;
		const href = linkEl.getAttribute('data-href') ?? linkEl.getAttribute('href');
		if (href === null || href.length === 0) return;
		ev.preventDefault();
		ev.stopPropagation();
		const newPane = forceNewPane || ev.ctrlKey || ev.metaKey;
		const sourcePath = this.getActiveSession()?.boundFile?.path ?? '';
		void this.app.workspace.openLinkText(href, sourcePath, newPane);
	}

}

/**
 * Pixel threshold for "near the bottom" of the transcript. A larger
 * threshold makes the auto-scroll-resume more forgiving; a smaller one
 * requires the user to scroll closer to the bottom edge before we
 * resume following the stream. 100px (≈3 lines) matches typical chat-
 * client behavior.
 */
const NEAR_BOTTOM_THRESHOLD_PX = 100;

function isNearBottom(el: HTMLElement, threshold = NEAR_BOTTOM_THRESHOLD_PX): boolean {
	return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
}

