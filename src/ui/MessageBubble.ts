import { type App, type Component, MarkdownRenderer } from 'obsidian';
import { sanitizeAssistantMarkdown } from '../chat/sanitize';
import type { ChatMessage } from '../chat/prompt';

// Renders a single message bubble in the Operator's Console design.
//
// Layout: two-column grid (gutter | rail | content). The gutter shows
// a 7ch mono role label + em-dash filler + timestamp. The rail is a 1px
// vertical line on assistant turns only; user turns omit it. The content
// column holds the message body, an action bar, and an optional token
// meter. No bubble background, no border-radius, no rounded box.
//
// Design invariant: role labels must be ≤10 characters to fit the
// `--yunseul-gutter-ch: 10` gutter. The current vocabulary:
//   'You' (3), 'Yunseul' (7), 'Sys' (3). Future roles (tool, etc.)
//   must fit within 10ch or the gutter width must be widened in
//   styles.css to match.
//
// For assistant content we sanitize the markdown source then call
// `MarkdownRenderer.render`, which is the only sanctioned path for
// inserting markdown HTML into the DOM.

export interface BubbleOptions {
	app: App;
	component: Component;
	sourcePath: string;
	isStreaming: boolean;
	allowExternalImages: boolean;
	onCopy: (text: string) => void;
	onAppend?: (text: string) => void;
	onRetry?: (text: string) => void;
	onStop?: () => void;
	// Optional human-readable model id used in the prefill indicator
	// after ~10s ("Sharpening · {model} loading…"). When absent the
	// indicator stays generic ("Sharpening…").
	modelLabel?: string;
}

export interface TokenInfo {
	input: number;
	output: number;
	costUsd?: number;
}

export interface BubbleHandle {
	root: HTMLElement;
	contentEl: HTMLElement;
	messageTs: number;
	/**
	 * Show the streaming caret + "Sharpening…" prefill indicator in
	 * the bubble body. Used during the prefill window before the first
	 * token arrives. The indicator is auto-cleared the next time
	 * `updateContent` runs.
	 */
	setThinking: () => void;
	updateContent: (text: string, opts: { isFinal: boolean }) => Promise<void>;
	markComplete: () => void;
	setTokenInfo: (info: TokenInfo) => void;
}

export function renderMessageBubble(
	container: HTMLElement,
	msg: ChatMessage,
	opts: BubbleOptions,
): BubbleHandle {
	const root = container.createDiv({
		cls: `yunseul-msg yunseul-msg-${msg.role}`,
		attr: { role: 'article', 'aria-label': `Message from ${ariaRole(msg.role)}` },
	});

	// Gutter row — spans all three grid columns.
	const gutter = root.createDiv({ cls: 'yunseul-msg-gutter' });
	gutter.createSpan({
		cls: 'yunseul-msg-role',
		text: roleLabel(msg.role),
		attr: { 'aria-label': ariaRole(msg.role) },
	});
	gutter.createSpan({
		cls: 'yunseul-msg-gutter-fill',
		text: '——————————————————',
		attr: { 'aria-hidden': 'true' },
	});
	gutter.createSpan({
		cls: 'yunseul-msg-ts yunseul-tnum',
		text: fmtTimestamp(msg.ts),
		attr: { 'aria-label': `Sent at ${fmtTimestamp(msg.ts)}` },
	});

	// Rail column — only rendered for assistant turns.
	if (msg.role === 'assistant') {
		root.createDiv({ cls: 'yunseul-msg-rail', attr: { 'aria-hidden': 'true' } });
	}

	// Content column — body + actions + (optional) token meter.
	const content = root.createDiv({ cls: 'yunseul-msg-content' });
	const body = content.createDiv({ cls: 'yunseul-msg-body' });

	const actions = content.createDiv({ cls: 'yunseul-msg-actions' });
	const copyBtn = actions.createEl('button', {
		text: 'Copy',
		cls: 'yunseul-msg-action',
		attr: { 'aria-label': 'Copy message' },
	});
	opts.component.registerDomEvent(copyBtn, 'click', () => {
		const cur = root.dataset.fullText ?? msg.content;
		opts.onCopy(cur);
	});

	if (opts.onAppend !== undefined && msg.role === 'assistant') {
		const appendBtn = actions.createEl('button', {
			text: 'Append',
			cls: 'yunseul-msg-action',
			attr: { 'aria-label': 'Append to bound note' },
		});
		opts.component.registerDomEvent(appendBtn, 'click', () => {
			const cur = root.dataset.fullText ?? msg.content;
			opts.onAppend?.(cur);
		});
	}

	if (opts.onRetry !== undefined && msg.role === 'assistant') {
		const retryBtn = actions.createEl('button', {
			text: 'Retry',
			cls: 'yunseul-msg-action',
			attr: { 'aria-label': 'Retry from this turn' },
		});
		opts.component.registerDomEvent(retryBtn, 'click', () => {
			const cur = root.dataset.fullText ?? msg.content;
			opts.onRetry?.(cur);
		});
	}

	let stopBtn: HTMLButtonElement | null = null;
	if (opts.onStop !== undefined && opts.isStreaming) {
		stopBtn = actions.createEl('button', {
			text: 'Stop',
			cls: 'yunseul-msg-action',
			attr: { 'aria-label': 'Stop streaming' },
		});
		opts.component.registerDomEvent(stopBtn, 'click', () => opts.onStop?.());
	}

	// Token meter — only created if setTokenInfo is invoked.
	let tokensEl: HTMLDivElement | null = null;

	// Prefill timer handle — cleared on first updateContent (or markComplete).
	let prefillStart = 0;
	let prefillTimer: number | null = null;
	let prefillLabel: HTMLSpanElement | null = null;
	let prefillElapsed: HTMLSpanElement | null = null;
	let _prefillCaret: HTMLSpanElement | null = null;
	// Sr-only spans inserted at stream start / completion for single
	// polite announcements (not per-token live region — that would
	// overwhelm screen readers).
	let srStartEl: HTMLSpanElement | null = null;
	let srEndEl: HTMLSpanElement | null = null;

	const clearPrefill = (): void => {
		if (prefillTimer !== null) {
			window.clearInterval(prefillTimer);
			prefillTimer = null;
		}
		prefillStart = 0;
		prefillLabel = null;
		prefillElapsed = null;
		_prefillCaret = null;
	};

	const setThinking = (): void => {
		clearPrefill();
		body.empty();
		// aria-busy on the bubble root (not just body) signals to AT that
		// the whole article is being assembled — the ancestor `role=log`
		// transcript will defer announcements properly. Cleared in
		// updateContent(isFinal:true) and markComplete.
		root.setAttr('aria-busy', 'true');
		_prefillCaret = body.createSpan({
			cls: 'yunseul-caret',
			text: '▍',
			attr: { 'aria-hidden': 'true' },
		});
		// Prefill label + elapsed counter are visual-only. aria-hidden so
		// the 500ms timer mutations don't fire polite announcements while
		// the assistant is "thinking". The one-shot srStartEl below is
		// the announcement AT users hear.
		prefillLabel = body.createSpan({
			cls: 'yunseul-thinking-label',
			text: 'Sharpening…',
			attr: { 'aria-hidden': 'true' },
		});
		prefillElapsed = body.createSpan({
			cls: 'yunseul-thinking-elapsed yunseul-tnum',
			attr: { 'aria-hidden': 'true' },
		});
		// SR announcement (one-shot at stream start). role=status implies
		// aria-live=polite, so we set the role only and skip the redundant
		// aria-live attribute.
		if (srStartEl !== null) srStartEl.remove();
		srStartEl = root.createSpan({
			cls: 'yunseul-sr-only',
			text: 'Assistant is responding',
			attr: { role: 'status' },
		});
		prefillStart = Date.now();
		prefillTimer = window.setInterval(() => {
			if (prefillLabel === null || prefillElapsed === null) return;
			const elapsedSec = Math.floor((Date.now() - prefillStart) / 1000);
			if (elapsedSec >= 10 && opts.modelLabel !== undefined && opts.modelLabel.length > 0) {
				prefillLabel.setText(`Sharpening · ${opts.modelLabel} loading…`);
				prefillElapsed.setText('');
			} else if (elapsedSec >= 4) {
				prefillElapsed.setText(` ${elapsedSec}s`);
			}
		}, 500);
		opts.component.registerInterval(prefillTimer);
	};

	// Two-phase render contract (load-bearing — preserves O(N) streaming
	// while still rendering full markdown at completion):
	//   - During stream (every ~33ms tick): O(N) text-node mutation. Body
	//     hosts one Text node + one streaming caret; updates set
	//     `streamTextNode.nodeValue = text` then re-append the caret so it
	//     stays the last child. NO body.empty(), NO sanitize, NO
	//     MarkdownRenderer.render — those are forbidden during stream by
	//     the workflow brief because they re-parse the full buffer each
	//     tick (O(N²) over the stream) and create caret-leak races with
	//     the final-phase render.
	//   - On isFinal: run the full sanitize + MarkdownRenderer.render
	//     pipeline ONCE, replacing the cheap text path with rendered DOM.
	// Torn-DOM safety: subsequent ticks check body.contains(streamTextNode)
	// before mutating; the final branch nulls streamTextNode so a concurrent
	// throttled invoke that beats the final-phase awaiter becomes a no-op.
	let streamTextNode: Text | null = null;
	let streamCaretEl: HTMLSpanElement | null = null;

	const resetStreamLocals = (): void => {
		streamTextNode = null;
		streamCaretEl = null;
	};

	const appendStreamingCaret = (): HTMLSpanElement => body.createSpan({
		cls: 'yunseul-caret',
		text: '▍',
		attr: { 'aria-hidden': 'true' },
	});

	const seedCheapPath = (): void => {
		const doc = body.ownerDocument;
		streamTextNode = doc.createTextNode('');
		body.appendChild(streamTextNode);
		streamCaretEl = appendStreamingCaret();
	};

	const runMarkdownRender = async (text: string): Promise<void> => {
		const sanitized = sanitizeAssistantMarkdown(text, {
			allowExternalImages: opts.allowExternalImages,
		});
		await MarkdownRenderer.render(opts.app, sanitized, body, opts.sourcePath, opts.component);
	};

	const updateContent = async (text: string, o: { isFinal: boolean }): Promise<void> => {
		root.dataset.fullText = text;

		if (msg.role !== 'assistant') {
			clearPrefill();
			body.empty();
			body.setText(text);
			if (o.isFinal) root.removeAttribute('aria-busy');
			else root.setAttr('aria-busy', 'true');
			return;
		}

		// Final phase: tear down cheap path, run full markdown render once.
		// resetStreamLocals BEFORE the await so any in-flight throttled
		// stream tick that beats us to body.contains() bails on its
		// torn-DOM guard rather than appending a stranded caret.
		if (o.isFinal) {
			clearPrefill();
			body.empty();
			resetStreamLocals();
			await runMarkdownRender(text);
			root.removeAttribute('aria-busy');
			return;
		}

		root.setAttr('aria-busy', 'true');

		// Stream phase, first non-final tick: clear thinking indicator and
		// seed cheap path under a freshly emptied body.
		if (streamTextNode === null) {
			clearPrefill();
			body.empty();
			seedCheapPath();
			if (streamTextNode !== null) {
				(streamTextNode as Text).nodeValue = text;
			}
			return;
		}

		// Subsequent ticks: torn-DOM safety. If body was wiped from under
		// us (final phase ran), the node is no longer connected — bail and
		// let final-phase rendering complete.
		if (!body.contains(streamTextNode)) {
			resetStreamLocals();
			return;
		}

		// Cheap tick: update the single text node carrying the FULL streamed
		// buffer (not a suffix — the cheap path owns body's contents for
		// the entire stream phase). appendChild on the attached caret moves
		// it, keeping it as the last child of body.
		streamTextNode.nodeValue = text;
		if (streamCaretEl !== null) body.appendChild(streamCaretEl);
	};

	const markComplete = (): void => {
		clearPrefill();
		if (stopBtn !== null) {
			stopBtn.remove();
			stopBtn = null;
		}
		root.removeAttribute('aria-busy');
		// End-of-stream announcement: role=status is sufficient (it
		// implies aria-live=polite). Centralized here so the ordering of
		// updateContent(isFinal) + markComplete can't double-announce or
		// miss the announcement.
		//
		// UX TRADEOFF (intentional, documented for future audits): the
		// status span announces a fixed boilerplate string rather than
		// the assistant's reply text. This is paired with A6's
		// `aria-relevant=additions` on the transcript log (no `text`),
		// which silences per-token announcements during streaming.
		// Combined, screen reader users hear "Assistant finished
		// responding" but NOT the reply body — they must navigate into
		// the bubble (via the article landmark) to read it. The
		// alternative — populating srEndEl with the full reply — would
		// flood the live region on every long answer and reintroduce
		// the streaming-spam problem A6 was created to solve. Do NOT
		// "fix" this by re-adding `text` to aria-relevant; consider a
		// short summary preview instead if the boilerplate proves
		// insufficient in user testing.
		if (srEndEl === null && msg.role === 'assistant') {
			srEndEl = root.createSpan({
				cls: 'yunseul-sr-only',
				text: 'Assistant finished responding',
				attr: { role: 'status' },
			});
		}
	};

	const setTokenInfo = (info: TokenInfo): void => {
		if (tokensEl === null) {
			tokensEl = content.createDiv({
				cls: 'yunseul-msg-tokens yunseul-tnum',
			});
		}
		tokensEl.empty();
		const inEl = tokensEl.createSpan({ cls: 'yunseul-tnum', text: formatNumber(info.input) });
		tokensEl.createSpan({ text: '→', attr: { 'aria-hidden': 'true' } });
		const outEl = tokensEl.createSpan({ cls: 'yunseul-tnum', text: formatNumber(info.output) });
		tokensEl.createSpan({ text: ' tok' });
		if (info.costUsd !== undefined) {
			tokensEl.createSpan({ text: ' · ', attr: { 'aria-hidden': 'true' } });
			tokensEl.createSpan({ text: `$${info.costUsd.toFixed(4)}` });
		}
		// Mark child refs as used so the lint pass doesn't trip; both are
		// assigned-not-read because the visible chars come from setText.
		void inEl;
		void outEl;
		tokensEl.setAttr(
			'aria-label',
			`Token usage: ${info.input} input, ${info.output} output`,
		);
	};

	return {
		root,
		contentEl: content,
		messageTs: msg.ts,
		setThinking,
		updateContent,
		markComplete,
		setTokenInfo,
	};
}

function roleLabel(role: ChatMessage['role']): string {
	switch (role) {
		case 'user':
			return 'You';
		case 'assistant':
			return 'Yunseul';
		case 'system':
			return 'Sys';
	}
}

function ariaRole(role: ChatMessage['role']): string {
	switch (role) {
		case 'user':
			return 'You';
		case 'assistant':
			return 'Assistant';
		case 'system':
			return 'System';
	}
}

function fmtTimestamp(ts: number): string {
	try {
		return new Intl.DateTimeFormat([], {
			hour: '2-digit',
			minute: '2-digit',
			hour12: false,
		}).format(new Date(ts));
	} catch {
		const d = new Date(ts);
		const pad = (n: number): string => String(n).padStart(2, '0');
		return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
	}
}

function formatNumber(n: number): string {
	// Locale-agnostic thousands separator using non-breaking thin space
	// would be ideal, but '1,240' is the universal expectation.
	return n.toLocaleString('en-US');
}
