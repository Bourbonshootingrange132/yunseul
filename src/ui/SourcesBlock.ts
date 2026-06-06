import { type Component, setIcon } from 'obsidian';
import type { BubbleHandle } from './MessageBubble';
import type { RetrievalResult } from '../index/retriever';

// Renders the 'Sources' disclosure under an assistant bubble (header +
// chevron + relevance bars + 'Show all'). Collapse state is per-view-
// lifetime only — NOT persisted across plugin reload. Retrieval hits
// live in session.lastRetrieval (in-memory, reset on construction) and
// renderHistoryFor never invokes renderSourcesBlock for past assistant
// turns, so there is no cross-reload story to preserve.

/**
 * Stable composite key identifying a particular assistant turn's
 * sources block. Encodes both sessionId and historyIndex so a single
 * flat Map<SourcesKey, boolean> on the orchestrator can store collapse
 * state for every block across every session in the view's lifetime.
 */
export type SourcesKey = string;

/**
 * Compose a SourcesKey from a session id and the history index of the
 * assistant turn the block belongs to. The order is `${sessionId}:${index}`.
 * The orchestrator must derive the index AFTER confirming the last
 * history entry is an assistant role — see code comment at the call site.
 */
export function makeSourcesKey(sessionId: string, historyIndex: number): SourcesKey {
	return `${sessionId}:${historyIndex}`;
}

/**
 * Host hooks the SourcesBlock needs from the orchestrator: the parent
 * Component for listener registration, plus accessors for the persisted-
 * per-view collapse Map. Keeping these on a small interface lets the
 * module stay free of any orchestrator-specific types.
 */
export interface SourcesBlockHost {
	component: Component;
	getCollapsed(key: SourcesKey): boolean;
	setCollapsed(key: SourcesKey, collapsed: boolean): void;
}

const MAX_DEFAULT = 5;

export function renderSourcesBlock(
	handle: BubbleHandle,
	hits: RetrievalResult[],
	key: SourcesKey,
	host: SourcesBlockHost,
): void {
	const contentEl = handle.contentEl;
	if (contentEl === undefined) return;
	// Remove any prior block (e.g. on retry).
	const prior = contentEl.querySelector('.yunseul-sources');
	if (prior !== null) prior.remove();

	const isCollapsed = host.getCollapsed(key);

	const block = contentEl.createDiv({ cls: 'yunseul-sources' });
	if (isCollapsed) block.addClass('is-collapsed');

	const header = block.createEl('button', {
		cls: 'yunseul-sources-header',
		attr: {
			'aria-expanded': isCollapsed ? 'false' : 'true',
			'aria-label': isCollapsed
				? 'Toggle sources list, collapsed'
				: 'Toggle sources list, expanded',
		},
	});
	header.createSpan({ cls: 'yunseul-sources-label', text: 'Sources' });
	header.createDiv({ cls: 'yunseul-sources-rule', attr: { 'aria-hidden': 'true' } });
	header.createSpan({
		cls: 'yunseul-sources-count yunseul-tnum',
		text: String(hits.length),
	});
	const chevron = header.createSpan({
		cls: 'yunseul-sources-chevron',
		attr: { 'aria-hidden': 'true' },
	});
	setIcon(chevron, 'chevron-down');

	const list = block.createEl('ul', { cls: 'yunseul-sources-list' });

	let showingAll = hits.length <= MAX_DEFAULT;

	const renderRows = (): void => {
		list.empty();
		const slice = showingAll ? hits : hits.slice(0, MAX_DEFAULT);
		for (const hit of slice) {
			renderSourceRow(list, hit);
		}
		if (!showingAll && hits.length > MAX_DEFAULT) {
			const showAllLi = list.createEl('li', { cls: 'yunseul-sources-row' });
			const btn = showAllLi.createEl('button', {
				cls: 'yunseul-sources-show-all',
				text: `Show all (${hits.length})`,
				attr: { 'aria-label': `Show all ${hits.length} sources` },
			});
			host.component.registerDomEvent(btn, 'click', () => {
				showingAll = true;
				renderRows();
			});
		}
	};
	renderRows();

	host.component.registerDomEvent(header, 'click', () => {
		const wasCollapsed = block.hasClass('is-collapsed');
		block.toggleClass('is-collapsed', !wasCollapsed);
		host.setCollapsed(key, !wasCollapsed);
		header.setAttr('aria-expanded', wasCollapsed ? 'true' : 'false');
		header.setAttr(
			'aria-label',
			wasCollapsed
				? 'Toggle sources list, expanded'
				: 'Toggle sources list, collapsed',
		);
	});
}

function renderSourceRow(list: HTMLUListElement, hit: RetrievalResult): void {
	const row = list.createEl('li', { cls: 'yunseul-sources-row' });

	// Clamp relevance score to a visible opacity range. The bar's opacity
	// encodes the score (0.30 → 30%, 0.95 → 95%), with hover snapping to
	// full via CSS. setCssStyles is Obsidian's sanctioned API for dynamic
	// style changes (lint rule against direct .style.* assignment).
	const opacity = Math.max(0.3, Math.min(0.95, hit.score));
	const bar = row.createSpan({
		cls: 'yunseul-sources-bar',
		attr: { 'aria-hidden': 'true' },
	});
	bar.setCssStyles({ opacity: String(opacity) });

	const target = sanitizeWikilinkTarget(hit.file.path.replace(/\.md$/i, ''));
	const score = formatScore(hit.score);
	const link = row.createEl('a', {
		cls: 'internal-link yunseul-sources-name',
		text: hit.file.basename,
		attr: {
			'data-href': target,
			href: target,
			'aria-label': `Open ${hit.file.path}, relevance score ${score}`,
			title: hit.file.path,
		},
	});
	// MarkdownRenderer normally adds these; we render the row directly
	// so set them ourselves. The transcript-level click handler routes
	// the click through workspace.openLinkText.
	link.dataset.href = target;

	// Dotted leaders fill the middle. The CSS sets flex-basis:0 + overflow:
	// hidden on the leaders span, so a generous string clips cleanly at the
	// score edge while leaving the name span as much natural width as the
	// row affords. The string just needs to be long enough to never look
	// short on a wide pane; 32 dots × ~0.5em letter-spacing ≈ 16em is enough.
	row.createSpan({
		cls: 'yunseul-sources-leaders',
		text: '·'.repeat(32),
		attr: { 'aria-hidden': 'true' },
	});

	row.createSpan({
		cls: 'yunseul-sources-score yunseul-tnum',
		text: score,
		attr: { 'aria-hidden': 'true' },
	});
}

// Sanitize a string that will appear inside `[[...]]` as the link target.
function sanitizeWikilinkTarget(s: string): string {
	// eslint-disable-next-line no-control-regex
	return s.replace(/[\x00-\x1f\x7f-\x9f[\]|^#<>\\]/g, '');
}

// Format a BM25 score for display.
function formatScore(score: number): string {
	if (!Number.isFinite(score)) return '0.00';
	const clamped = Math.min(Math.max(score, 0), 99.99);
	return clamped.toFixed(2);
}
