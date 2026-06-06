import { type Component } from 'obsidian';
import type { ChatSession } from '../chat/session';
import type YunseulPlugin from '../main';

// Textarea + send/stop button + slash hint + Cmd-Enter hint + context
// pill + token meter. Owns its own DOM, the auto-grow resize, and
// typing/has-bound classes. Does NOT toggle the connection-dot's
// is-streaming class — the orchestrator's setStreamingUI helper routes
// that through ChatHeader.setStreamingPulse so composer and header
// cannot drift.

export interface ChatComposerOptions {
	root: HTMLElement;
	component: Component;
	plugin: YunseulPlugin;
	slashHintId: string;
	getActiveSession: () => ChatSession | undefined;
	onSendOrStop: () => void;
	onBindFile: () => void;
	onUnbindFile: () => void;
	onPreviousFocus: () => void;
}

export interface ChatComposerHandle {
	inputEl: HTMLTextAreaElement;
	sendBtn: HTMLButtonElement;
	frameEl: HTMLDivElement;
	updateContextRow(): void;
	setSendButtonStreaming(streaming: boolean): void;
	setSlashHintDescribedBy(on: boolean): void;
	focus(): void;
	getValue(): string;
	setValue(v: string): void;
	resize(): void;
}

export function renderChatComposer(opts: ChatComposerOptions): ChatComposerHandle {
	const composer = opts.root.createDiv({ cls: 'yunseul-composer' });
	const frameEl = composer.createDiv({ cls: 'yunseul-composer-frame' });

	// `aria-describedby` is attached dynamically via setSlashHintDescribedBy
	// so it never references a missing id. Two open chat leaves never collide
	// because the id is per-view (opts.slashHintId is randomized by the
	// orchestrator on onOpen).
	const inputEl = frameEl.createEl('textarea', {
		cls: 'yunseul-textarea',
		attr: {
			placeholder: 'Ask Yunseul',
			'aria-label': 'Chat message',
			rows: '1',
		},
	});

	opts.component.registerDomEvent(inputEl, 'keydown', (ev: KeyboardEvent) => {
		if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
			ev.preventDefault();
			opts.onSendOrStop();
			return;
		}
		if (ev.key === 'Escape') {
			opts.onPreviousFocus();
		}
	});

	opts.component.registerDomEvent(inputEl, 'input', () => {
		resize();
		frameEl.toggleClass('is-typing', inputEl.value.length > 0);
		updateContextRow();
	});

	// Below textarea: slash hint + send strip.
	const strip = frameEl.createDiv({ cls: 'yunseul-composer-strip' });
	const slashHint = strip.createDiv({
		cls: 'yunseul-composer-slash-hint',
		attr: { 'aria-hidden': 'true' },
	});
	slashHint.createEl('kbd', {
		cls: 'yunseul-slash-badge',
		text: '/',
	});
	slashHint.createSpan({ text: ' file, tag, or prompt' });

	const sendHint = strip.createDiv({ cls: 'yunseul-composer-send-hint' });
	// Hint must match the keydown handler above: plain Enter sends,
	// Shift+Enter inserts a newline. The earlier hint advertised
	// Cmd/Ctrl+Enter which contradicted the actual binding and
	// confused users who pressed Enter expecting a newline.
	const kbdHint = sendHint.createSpan({ attr: { 'aria-hidden': 'true' } });
	kbdHint.createEl('kbd', { text: 'Enter' });
	kbdHint.createSpan({ text: ' to send · ' });
	kbdHint.createEl('kbd', { text: 'Shift+Enter' });
	kbdHint.createSpan({ text: ' for newline' });

	const sendBtn = sendHint.createEl('button', {
		cls: 'yunseul-send-btn',
		attr: { 'aria-label': 'Send message' },
	});
	sendBtn.createSpan({
		cls: 'yunseul-send-glyph',
		text: '▶',
		attr: { 'aria-hidden': 'true' },
	});
	sendBtn.createSpan({ text: 'Send' });
	opts.component.registerDomEvent(sendBtn, 'click', () => {
		opts.onSendOrStop();
	});

	// Context affordance row. Pill is a role=group container so the
	// change-binding and unbind buttons inside can be siblings (nested
	// <button> is invalid HTML and AT may not announce the inner one).
	const ctx = frameEl.createDiv({ cls: 'yunseul-composer-context' });

	const contextPillEl = ctx.createDiv({
		cls: 'yunseul-context-pill',
		attr: { role: 'group', 'aria-label': 'Bound note' },
	});

	const contextTokensEl = ctx.createSpan({
		cls: 'yunseul-context-tokens yunseul-tnum',
		attr: { 'aria-label': 'Context size' },
	});

	const updateContextRow = (): void => {
		// Render the pill and tokens unconditionally — even when no
		// session is active. Returning early on `session === undefined`
		// left the pill empty at mount, then populated it on first
		// keystroke, which made the context row visibly grow (~35px →
		// ~59px). Always rendering keeps the row a stable height.
		const session = opts.getActiveSession();
		const boundFile = session?.boundFile ?? null;

		contextPillEl.empty();
		if (boundFile !== null) {
			contextPillEl.setAttr('aria-label', `Bound note: ${boundFile.basename}`);
			const changeBtn = contextPillEl.createEl('button', {
				cls: 'yunseul-context-change',
				attr: { 'aria-label': `Change bound note (currently ${boundFile.basename})` },
			});
			changeBtn.createSpan({ text: '#', attr: { 'aria-hidden': 'true' } });
			changeBtn.createSpan({ text: ` ${boundFile.basename}` });
			opts.component.registerDomEvent(changeBtn, 'click', () => {
				opts.onBindFile();
			});
			const unbind = contextPillEl.createEl('button', {
				cls: 'yunseul-context-unbind',
				text: '×',
				attr: { 'aria-label': `Unbind ${boundFile.basename}` },
			});
			opts.component.registerDomEvent(unbind, 'click', (ev: MouseEvent) => {
				// The context-unbind button is NOT a descendant of
				// transcriptEl, so stopPropagation here does not interfere
				// with the orchestrator's delegated internal-link click
				// handler. The nonGoal forbidding stopPropagation applies
				// only to transcript descendants.
				ev.stopPropagation();
				opts.onUnbindFile();
			});
		} else {
			contextPillEl.setAttr('aria-label', 'No note bound');
			const bindBtn = contextPillEl.createEl('button', {
				cls: 'yunseul-context-change',
				text: 'bind a note ↑',
				attr: { 'aria-label': 'Bind a note to this session' },
			});
			opts.component.registerDomEvent(bindBtn, 'click', () => {
				opts.onBindFile();
			});
		}

		const cap = opts.plugin.settings.lmStudio.maxContextChars;
		const used = session !== undefined ? estimateContextChars(session) : 0;
		contextTokensEl.setText(`${formatThousands(used)}/${formatThousands(cap)}`);
		contextTokensEl.setAttr('aria-label', `Context: ${used} of ${cap} characters used`);

		frameEl.toggleClass('has-bound', boundFile !== null);
	};

	const resize = (): void => {
		// Auto-grow disabled — the textarea is now CSS-locked at a fixed
		// height (see .yunseul-textarea in styles.css). The exported
		// resize handle is kept as a no-op so external callers don't break.
		// Content overflows internally via CSS overflow-y: auto.
	};

	const setSendButtonStreaming = (streaming: boolean): void => {
		sendBtn.empty();
		if (streaming) {
			sendBtn.createSpan({
				cls: 'yunseul-send-glyph',
				text: '■',
				attr: { 'aria-hidden': 'true' },
			});
			sendBtn.createSpan({ text: 'Stop' });
			sendBtn.setAttr('aria-label', 'Stop streaming');
			sendBtn.addClass('is-streaming');
		} else {
			sendBtn.createSpan({
				cls: 'yunseul-send-glyph',
				text: '▶',
				attr: { 'aria-hidden': 'true' },
			});
			sendBtn.createSpan({ text: 'Send' });
			sendBtn.setAttr('aria-label', 'Send message');
			sendBtn.removeClass('is-streaming');
		}
	};

	const setSlashHintDescribedBy = (on: boolean): void => {
		if (on) {
			inputEl.setAttr('aria-describedby', opts.slashHintId);
		} else {
			inputEl.removeAttribute('aria-describedby');
		}
	};

	updateContextRow();

	return {
		inputEl,
		sendBtn,
		frameEl,
		updateContextRow,
		setSendButtonStreaming,
		setSlashHintDescribedBy,
		focus: () => inputEl.focus(),
		getValue: () => inputEl.value,
		setValue: (v: string) => {
			inputEl.value = v;
		},
		resize,
	};
}

function estimateContextChars(session: ChatSession): number {
	// Rough estimate based on history + bound-file basename. The actual
	// budget includes the full bound-file excerpt and any retrieved
	// chunks, both of which are computed lazily at send time, so we
	// approximate here.
	let chars = 0;
	for (const m of session.history) {
		chars += m.content.length;
	}
	if (session.boundFile !== null) {
		chars += session.boundFile.path.length;
	}
	return chars;
}

function formatThousands(n: number): string {
	if (n >= 1000) {
		return `${Math.round(n / 1000)}k`;
	}
	return String(n);
}
