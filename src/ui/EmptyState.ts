import type { Component } from 'obsidian';
import type { ChatSession } from '../chat/session';

// First-load chrome (tagline + sub-tagline + bound-file pill + quick-
// start chips + slash/hash/date hint + version footer) when transcript
// is empty. Owns its rendered subtree only; teardown is element removal.
//
// The aria-describedby wiring on the orchestrator-owned textarea is
// performed by the orchestrator AROUND the EmptyStateHandle lifetime —
// see the renderFix notes on EmptyState in the plan.

export interface EmptyStateOptions {
	container: HTMLElement;
	component: Component;
	session: ChatSession;
	suggestions: ReadonlyArray<string>;
	pluginVersion: string;
	slashHintId: string;
	/**
	 * Webview-safe URL to assets/logo.png (computed by the orchestrator
	 * via app.vault.adapter.getResourcePath). When null the empty state
	 * renders without a logo. Always optional so tests that don't mock
	 * the adapter can omit it.
	 */
	logoUrl?: string | null;
	onSuggestionPick: (text: string) => void;
	/**
	 * Invoked when the user clicks the `×` next to the bound-file
	 * indicator in the empty state. The orchestrator MUST execute all
	 * four side effects the legacy inline handler did:
	 *   1) session.boundFile = null
	 *   2) renderHistoryFor(session) — tears down and re-mounts the
	 *      empty state
	 *   3) header.setStatus(session) — refresh the file segment
	 *   4) composer.updateContextRow() — refresh the pill + token meter
	 */
	onUnbindBoundFile: () => void;
}

export interface EmptyStateHandle {
	rootEl: HTMLElement;
	remove(): void;
}

const TAGLINE_ID = 'yunseul-empty-tagline-id';

export function renderEmptyState(opts: EmptyStateOptions): EmptyStateHandle {
	const empty = opts.container.createEl('section', {
		cls: 'yunseul-empty',
		attr: { 'aria-labelledby': TAGLINE_ID },
	});

	// Optional logo. Decorative — aria-hidden so screen readers skip it
	// (the tagline below carries the meaningful heading).
	if (opts.logoUrl !== undefined && opts.logoUrl !== null && opts.logoUrl.length > 0) {
		empty.createEl('img', {
			cls: 'yunseul-empty-logo',
			attr: {
				src: opts.logoUrl,
				alt: '',
				'aria-hidden': 'true',
			},
		});
	}

	// Optional bound-file indicator above the tagline.
	if (opts.session.boundFile !== null) {
		const file = opts.session.boundFile;
		const bound = empty.createDiv({ cls: 'yunseul-empty-bound' });
		bound.createSpan({ text: '#', attr: { 'aria-hidden': 'true' } });
		bound.createSpan({ text: ` ${file.basename}` });
		const clearBtn = bound.createEl('button', {
			cls: 'yunseul-context-unbind',
			text: '×',
			attr: { 'aria-label': `Unbind ${file.basename}` },
		});
		opts.component.registerDomEvent(clearBtn, 'click', () => {
			opts.onUnbindBoundFile();
		});
	}

	empty.createEl('h2', {
		cls: 'yunseul-empty-tagline',
		text: 'Where your notes catch the light.',
		attr: { id: TAGLINE_ID },
	});

	empty.createEl('p', {
		cls: 'yunseul-empty-subtagline',
		text: 'Chat with the current note, or pull context from anywhere in your vault.',
	});

	const list = empty.createDiv({ cls: 'yunseul-empty-suggestions' });
	for (let i = 0; i < opts.suggestions.length; i++) {
		const text = opts.suggestions[i];
		if (text === undefined) continue;
		const btn = list.createEl('button', {
			cls: 'yunseul-empty-suggestion',
			attr: { 'aria-label': text },
		});
		btn.createSpan({
			cls: 'yunseul-empty-num',
			text: String(i + 1).padStart(2, '0'),
			attr: { 'aria-hidden': 'true' },
		});
		btn.createSpan({ cls: 'yunseul-empty-text', text });
		opts.component.registerDomEvent(btn, 'click', () => {
			opts.onSuggestionPick(text);
		});
	}

	// The hint paragraph is retained as the aria-describedby target
	// (orchestrator sets `aria-describedby={slashHintId}` on the
	// composer textarea while EmptyState is mounted), but its visible
	// content is intentionally minimal — earlier wording advertised
	// `/` file picker, `#` tag picker, and `/YYYY-MM-DD` date filter
	// triggers that have never shipped, which confused users into
	// thinking the features were broken. When those pickers land the
	// hint text should be restored.
	const hint = empty.createEl('p', {
		cls: 'yunseul-empty-hint',
		attr: { id: opts.slashHintId },
	});
	hint.createSpan({ text: 'Bind a note to chat about it, or start typing to ask anything.' });

	empty.createEl('p', {
		cls: 'yunseul-empty-version',
		text: `Yunseul · v${opts.pluginVersion}`,
		attr: { 'aria-hidden': 'true' },
	});

	return {
		rootEl: empty,
		remove: () => empty.remove(),
	};
}
