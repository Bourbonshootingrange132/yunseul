import { type Component, Menu, Notice, setIcon } from 'obsidian';
import type { ChatSession } from '../chat/session';
import type { ConnectionState, ConnectionStatusValue } from '../lmstudio/health';
import type YunseulPlugin from '../main';

// Renders TWO siblings into opts.root in fixed order:
//   1. bannerEl   (yunseul-banner, role=alert, initially hidden)
//   2. the header region (wordmark row + status strip)
//
// This preserves the current DOM hierarchy where bannerEl is a sibling
// of the header region (NOT a child). DO NOT refactor banner ownership
// outside this module — the position is load-bearing for the offline
// affordance to sit ABOVE everything else.

// Matches probable API-key-shaped strings so we don't expose pasted keys
// in the status strip. Heuristic — accepts:
//   sk-... (Anthropic / OpenAI style)
//   40+ char base62 strings with no separators (often raw tokens)
const API_KEY_SHAPE = /^(?:sk-[A-Za-z0-9_-]{20,}|[A-Za-z0-9_-]{40,})$/;

export interface ChatHeaderOptions {
	root: HTMLElement;
	component: Component;
	plugin: YunseulPlugin;
	onNewChat: () => void;
	onExport: () => void;
	onCopyAll: () => void;
	onRetryConnection: () => void;
	/**
	 * Fired exactly when the offline→non-offline banner teardown leaves
	 * focus stranded on the (now-destroyed) Retry button. Orchestrator
	 * typically forwards this to composer.focus() so keyboard users
	 * don't lose their anchor.
	 */
	onBannerFocusEscaped: () => void;
	getActiveSession: () => ChatSession | undefined;
}

export interface ChatHeaderHandle {
	setStatus(session: ChatSession): void;
	setConnectionState(state: ConnectionState): void;
	setStreamingPulse(on: boolean): void;
	resolveModelLabel(): { visible: string; full: string; hidden: boolean };
}

export function renderChatHeader(opts: ChatHeaderOptions): ChatHeaderHandle {
	// CONTRACT — bannerEl is the FIRST sibling under opts.root; the
	// header region is the SECOND. See the module-level docstring.
	const bannerEl = opts.root.createDiv({
		cls: 'yunseul-banner',
		attr: { role: 'alert' },
	});
	bannerEl.hide();

	// `role=banner` is reserved for page-level headers; an Obsidian
	// leaf already lives inside Obsidian's own banner, so nesting one
	// here creates a duplicate landmark. Use `region` with an
	// aria-label instead so AT can still navigate to "Chat header".
	const header = opts.root.createDiv({
		cls: 'yunseul-chat-header',
		attr: { role: 'region', 'aria-label': 'Chat header' },
	});

	// Row 1: wordmark + action buttons.
	const headerBar = header.createDiv({ cls: 'yunseul-header-bar' });
	// Wordmark is decorative — Obsidian's ItemView contentEl already lives
	// inside a page-level h1 landmark, so a literal `<h1>` here would
	// create a duplicate top-level heading in the screen-reader outline
	// (audit A2 / WCAG 1.3.1). Use a styled <div> with role=presentation
	// so the visual hierarchy is unchanged while the semantic outline is
	// corrected. CSS targets `.yunseul-wordmark` — styling is preserved.
	headerBar.createDiv({
		cls: 'yunseul-wordmark',
		text: 'Yunseul',
		attr: { role: 'presentation' },
	});
	const actions = headerBar.createDiv({ cls: 'yunseul-header-actions' });

	const newBtn = actions.createEl('button', {
		cls: 'yunseul-header-btn',
		text: 'New',
		attr: { 'aria-label': 'Start a new session' },
	});
	opts.component.registerDomEvent(newBtn, 'click', () => {
		opts.onNewChat();
	});

	const exportBtn = actions.createEl('button', {
		cls: 'yunseul-header-btn',
		text: 'Export',
		attr: { 'aria-label': 'Export conversation as Markdown' },
	});
	opts.component.registerDomEvent(exportBtn, 'click', () => {
		opts.onExport();
	});

	const moreBtn = actions.createEl('button', {
		cls: 'yunseul-header-btn',
		text: '…',
		attr: {
			'aria-label': 'More actions',
			'aria-haspopup': 'menu',
			'aria-expanded': 'false',
		},
	});
	opts.component.registerDomEvent(moreBtn, 'click', (ev: MouseEvent) => {
		openMoreMenu(moreBtn, ev, opts.onCopyAll, opts.plugin);
	});

	// Row 2: status strip. `role=toolbar` would imply left/right arrow
	// navigation; we don't wire roving-tabindex, so use `group` to keep
	// the labeled area without over-promising semantics.
	const strip = header.createDiv({
		cls: 'yunseul-status-strip',
		attr: { role: 'group', 'aria-label': 'Session status' },
	});

	const modelSegEl = strip.createEl('button', {
		cls: 'yunseul-status-segment',
		attr: { 'aria-label': 'Model' },
	});
	opts.component.registerDomEvent(modelSegEl, 'click', () => {
		openYunseulSettings(opts.plugin);
	});

	strip.createSpan({
		cls: 'yunseul-status-sep',
		text: '·',
		attr: { 'aria-hidden': 'true' },
	});

	const fileSegEl = strip.createEl('button', {
		cls: 'yunseul-status-segment',
		attr: { 'aria-label': 'Bound note' },
	});
	opts.component.registerDomEvent(fileSegEl, 'click', () => {
		const s = opts.getActiveSession();
		if (s?.boundFile === undefined || s.boundFile === null) {
			new Notice('No note is bound to this session yet.');
			return;
		}
		void opts.plugin.app.workspace.getLeaf(false).openFile(s.boundFile);
	});

	strip.createSpan({
		cls: 'yunseul-status-sep',
		text: '·',
		attr: { 'aria-hidden': 'true' },
	});

	const ctxSegEl = strip.createEl('button', {
		cls: 'yunseul-status-segment',
		attr: { 'aria-label': 'Context size' },
	});
	opts.component.registerDomEvent(ctxSegEl, 'click', () => {
		const s = opts.getActiveSession();
		const cap = opts.plugin.settings.lmStudio.maxContextChars;
		const used = s !== undefined ? estimateContextChars(s) : 0;
		new Notice(`Context: ${used} of ${cap} characters used`);
	});

	strip.createSpan({
		cls: 'yunseul-status-sep',
		text: '·',
		attr: { 'aria-hidden': 'true' },
	});

	// Connection-status dot. Inline element gets aria-hidden; the
	// adjacent sr-only span carries the state text under role=status.
	const dotWrap = strip.createSpan({
		attr: { role: 'status', 'aria-live': 'polite' },
	});
	// `data-state` is a non-color disambiguator (audit A5 / WCAG 1.4.1):
	// the dot's CSS rule pairs each color with a distinct shape variant via
	// the [data-state="..."] selector, so colorblind users can tell ready /
	// unknown / offline apart without relying on hue alone.
	const dotEl = dotWrap.createSpan({
		cls: 'yunseul-status-dot is-unknown',
		attr: { 'aria-hidden': 'true', 'data-state': 'unknown' },
	});
	const dotSrEl = dotWrap.createSpan({
		cls: 'yunseul-sr-only',
		text: 'Unknown connection',
	});

	// Remember the last connection state we rendered for so we only
	// rebuild the banner (and re-fire its role=alert announcement) on a
	// real transition — flapping reconnects no longer assault AT users.
	// We diff on the discrete state + the actionable message so a
	// transition from offline/cors-blocked to offline/not-found
	// (provider switch mid-air) still re-renders with the new copy.
	let lastBannerState: ConnectionStatusValue | null = null;
	let lastBannerMessage: string | undefined;

	const resolveModelLabel = (): { visible: string; full: string; hidden: boolean } => {
		const settings = opts.plugin.settings;
		const raw = settings.provider === 'claude-code'
			? (settings.claudeCode.modelOverride.length > 0 ? settings.claudeCode.modelOverride : 'claude (default)')
			: (settings.lmStudio.chatModel.length > 0 ? settings.lmStudio.chatModel : '(no model)');
		if (API_KEY_SHAPE.test(raw)) {
			return {
				visible: '(model id hidden)',
				full: '(model id hidden)',
				hidden: true,
			};
		}
		return { visible: raw, full: raw, hidden: false };
	};

	const setStatus = (session: ChatSession): void => {
		const modelInfo = resolveModelLabel();
		const truncated = truncateMiddle(modelInfo.visible, 24);
		modelSegEl.setText(truncated);
		const aria = modelInfo.hidden
			? '(model id hidden — looks like an API key). Click to open Yunseul settings.'
			: `Model: ${modelInfo.full}. Click to open Yunseul settings.`;
		modelSegEl.setAttr('aria-label', aria);
		if (!modelInfo.hidden) {
			modelSegEl.setAttr('title', modelInfo.full);
		} else {
			modelSegEl.removeAttribute('title');
		}

		const file = session.boundFile;
		const visible = file !== null ? file.basename : 'none';
		fileSegEl.setText(truncateMiddle(visible, 24));
		fileSegEl.setAttr(
			'aria-label',
			file !== null
				? `Bound note: ${file.path}. Click to open.`
				: 'Bound note: none.',
		);
		if (file !== null) {
			fileSegEl.setAttr('title', file.path);
		} else {
			fileSegEl.removeAttribute('title');
		}

		const cap = opts.plugin.settings.lmStudio.maxContextChars;
		ctxSegEl.setText(`${formatThousands(cap)} ctx`);
		ctxSegEl.setAttr('aria-label', `Context size: up to ${cap} characters.`);
	};

	const setConnectionState = (envelope: ConnectionState): void => {
		const state = envelope.state;
		// Banner — only shown when offline. Rebuild only on real state
		// transitions (state/message changed) so role=alert doesn't
		// re-fire on every probe tick. If focus is on the Retry button
		// when we tear the banner down (reconnect succeeded), notify the
		// orchestrator so it can pull focus back to the composer.
		const transitioned = state !== lastBannerState || envelope.message !== lastBannerMessage;
		if (transitioned) {
			const wasBannerFocused = bannerEl.contains(activeDocument.activeElement);
			if (state === 'offline') {
				bannerEl.empty();
				bannerEl.show();
				const iconWrap = bannerEl.createSpan({
					cls: 'yunseul-banner-icon',
					attr: { 'aria-hidden': 'true' },
				});
				setIcon(iconWrap, 'wifi-off');
				bannerEl.createSpan({
					cls: 'yunseul-banner-title',
					text: 'Offline',
				});
				bannerEl.createSpan({
					cls: 'yunseul-banner-detail',
					text: ` ${formatBannerDetail(envelope, opts.plugin)}`,
				});
				const retry = bannerEl.createEl('button', { text: 'Retry' });
				opts.component.registerDomEvent(retry, 'click', () => {
					opts.onRetryConnection();
				});
			} else {
				bannerEl.empty();
				bannerEl.hide();
				if (wasBannerFocused) opts.onBannerFocusEscaped();
			}
			lastBannerState = state;
			lastBannerMessage = envelope.message;
		}

		// Status dot — color + shape disambiguator (data-state) + sr-only
		// state text. The `data-state` attribute mirrors the class to drive
		// the per-state CSS shape variant (audit A5 / WCAG 1.4.1).
		dotEl.removeClass('is-ready', 'is-offline', 'is-unknown');
		if (state === 'ready') {
			dotEl.addClass('is-ready');
			dotEl.setAttr('data-state', 'ready');
		} else if (state === 'offline') {
			dotEl.addClass('is-offline');
			dotEl.setAttr('data-state', 'offline');
		} else {
			dotEl.addClass('is-unknown');
			dotEl.setAttr('data-state', 'unknown');
		}

		if (state === 'ready') dotSrEl.setText('Connected');
		else if (state === 'offline') dotSrEl.setText('Disconnected');
		else dotSrEl.setText('Unknown connection');
	};

	const setStreamingPulse = (on: boolean): void => {
		// Mirror the streaming class onto the connection dot so its
		// pulse animation runs only during an active stream.
		dotEl.toggleClass('is-streaming', on);
	};

	return {
		setStatus,
		setConnectionState,
		setStreamingPulse,
		resolveModelLabel,
	};
}

function openMoreMenu(
	btnEl: HTMLButtonElement,
	ev: MouseEvent,
	onCopyAll: () => void,
	plugin: YunseulPlugin,
): void {
	const menu = new Menu();
	menu.addItem((i) =>
		i.setTitle('Copy all').onClick(() => {
			onCopyAll();
		}),
	);
	menu.addItem((i) =>
		i.setTitle('Open plugin settings').onClick(() => {
			openYunseulSettings(plugin);
		}),
	);
	btnEl.setAttr('aria-expanded', 'true');
	menu.onHide(() => {
		btnEl.setAttr('aria-expanded', 'false');
		btnEl.focus();
	});
	// Synthetic clicks from keyboard (Enter/Space on a button) fire
	// with detail === 0 and position 0,0; anchor the menu under the
	// button via getBoundingClientRect so it doesn't appear in the
	// top-left of the screen.
	if (ev.detail === 0) {
		const rect = btnEl.getBoundingClientRect();
		menu.showAtPosition({ x: rect.left, y: rect.bottom });
	} else {
		menu.showAtMouseEvent(ev);
	}
}

/**
 * Render the banner detail string for the offline state. Provider-aware:
 *
 *   - LM Studio + kind=`cors-blocked` → CORS-specific guidance
 *   - LM Studio + offline → server-at-baseUrl prompt
 *   - Claude Code + kind=`not-found` → binary path guidance
 *   - Claude Code + kind=`not-logged-in` → `claude login` hint
 *   - Claude Code + other kinds → carry the probe's own message verbatim
 *   - Generic fallback → existing Open-Settings string
 *
 * The envelope's `message` is preferred for unknown kinds because the
 * probe surfaced an actionable description already; only the well-known
 * kinds are augmented with copy that wouldn't fit a single probe line.
 */
function formatBannerDetail(envelope: ConnectionState, plugin: YunseulPlugin): string {
	const provider = plugin.settings.provider;
	const kind = envelope.kind;
	if (provider === 'lm-studio') {
		if (kind === 'cors-blocked') {
			return 'LM Studio reachable but CORS blocked — restart with --cors.';
		}
		return `LM Studio server offline at ${plugin.settings.lmStudio.baseUrl}. Retry?`;
	}
	if (provider === 'claude-code') {
		if (kind === 'not-found') {
			return '`claude` binary not found. Settings → Yunseul to set path.';
		}
		if (kind === 'not-logged-in') {
			return 'Not logged into Claude Code. Run `claude login`.';
		}
		if (envelope.message !== undefined && envelope.message.length > 0) {
			return envelope.message;
		}
		return 'Claude Code unavailable. Open Settings → Yunseul to fix.';
	}
	if (envelope.message !== undefined && envelope.message.length > 0) {
		return envelope.message;
	}
	return `Server at ${plugin.settings.lmStudio.baseUrl}. Open Settings → Yunseul to fix.`;
}

/**
 * Open the Yunseul tab in Obsidian's settings dialog directly.
 *
 * Obsidian exposes `app.setting.open()` / `app.setting.openTabById(id)`
 * for plugins to navigate users into their own settings — but the
 * shapes are not in the published `obsidian.d.ts` types. We cast
 * narrowly here and fall back to a Notice if the API ever changes.
 * Audit U7: status segments and the More menu used to fire a Notice
 * instructing the user to open settings manually, which is a 2-step
 * journey when the API can do it in one click.
 */
function openYunseulSettings(plugin: YunseulPlugin): void {
	type SettingAPI = {
		open: () => void;
		openTabById: (id: string) => void;
	};
	const appWithSetting = plugin.app as { setting?: SettingAPI };
	const settingApi = appWithSetting.setting;
	if (settingApi === undefined) {
		new Notice('Open Settings → Yunseul to configure.');
		return;
	}
	try {
		settingApi.open();
		settingApi.openTabById('yunseul');
	} catch (_e) {
		new Notice('Open Settings → Yunseul to configure.');
	}
}

function truncateMiddle(s: string, max: number): string {
	if (s.length <= max) return s;
	const tail = Math.max(8, Math.floor(max / 2));
	const head = Math.max(4, max - tail - 3);
	return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

function formatThousands(n: number): string {
	if (n >= 1000) {
		return `${Math.round(n / 1000)}k`;
	}
	return String(n);
}

function estimateContextChars(session: ChatSession): number {
	let chars = 0;
	for (const m of session.history) {
		chars += m.content.length;
	}
	if (session.boundFile !== null) {
		chars += session.boundFile.path.length;
	}
	return chars;
}
