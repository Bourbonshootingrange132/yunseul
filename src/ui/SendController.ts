import type { App } from 'obsidian';
import type { ChatSession } from '../chat/session';
import type { ChatMessage, BoundFileExcerpt } from '../chat/prompt';
import { throttle, type ThrottledFn } from '../util/throttle';
import { renderMessageBubble, type BubbleHandle } from './MessageBubble';
import { makeSourcesKey, renderSourcesBlock, type SourcesBlockHost } from './SourcesBlock';
import type YunseulPlugin from '../main';
import { TFile } from 'obsidian';

// Drives the per-send streaming pipeline: appends user + assistant bubbles,
// wires the throttled mid-stream updateContent, fans onComplete /
// onError side effects back into the orchestrator. Decoupled from the
// View via the SendControllerHost interface so the orchestrator stays
// the single owner of UI state.

export interface SendControllerHost {
	// Getter (not a field) so SendController always reads the LIVE
	// transcript element from the View. If a future refactor recreates
	// the transcript subtree mid-stream (e.g. a "clear messages" command),
	// the controller picks up the new element instead of holding a stale
	// reference captured at buildSendHost() time.
	getTranscriptEl(): HTMLElement | null;
	sourcesHost: SourcesBlockHost;
	getAllowExternalImages(): boolean;
	getSourcePath(session: ChatSession): string;
	getModelLabel(): string | undefined;
	onCopy(text: string): void;
	onAppend(session: ChatSession, text: string): void;
	scrollToBottom(): void;
	setStreaming(streaming: boolean): void;
	setThrottle(t: ThrottledFn<[string]> | null): void;
	logger: YunseulPlugin['logger'];
}

export interface SendArgs {
	app: App;
	plugin: YunseulPlugin;
	session: ChatSession;
	text: string;
	excerpt: BoundFileExcerpt | null;
	host: SendControllerHost;
}

/**
 * Run a full send/stream cycle. Mounts the user + assistant bubbles,
 * sets up the throttled mid-stream renderer, and orchestrates the
 * onToken / onComplete / onError fan-out. Sets `setStreaming(true)`
 * before stream start; `setStreaming(false)` in finally so the UI
 * always returns to the Send state even on throw.
 */
export async function runSend(args: SendArgs): Promise<void> {
	const { app, session, text, excerpt, host } = args;
	if (host.getTranscriptEl() === null) return;

	const userMsg: ChatMessage = { role: 'user', content: text.trim(), ts: Date.now() };
	appendBubble(app, session, userMsg, false, host);
	const assistantHandle = appendBubble(
		app,
		session,
		{ role: 'assistant', content: '', ts: Date.now() },
		true,
		host,
	);
	assistantHandle.setThinking();
	host.scrollToBottom();
	host.setStreaming(true);

	let buf = '';
	const isHandleLive = (): boolean =>
		host.getTranscriptEl()?.isConnected === true && assistantHandle.root.isConnected;
	const throttledUpdate = throttle((current: string) => {
		if (!isHandleLive()) return;
		void assistantHandle.updateContent(current, { isFinal: false });
		host.scrollToBottom();
	}, 33);
	host.setThrottle(throttledUpdate);

	try {
		await session.send(text, {
			boundFileExcerpt: excerpt,
			onToken: (token) => {
				buf += token;
				throttledUpdate(buf);
			},
			onComplete: (meta) => {
				// Cancel BEFORE awaiting so no new cheap ticks can interleave
				// with the final-phase render. Wrap the async tail in a void
				// IIFE so the SendContext's void-typed callback signature is
				// respected (the SendContext API is sync — session.send fires
				// these and doesn't await them); the post-await side effects
				// (markComplete, setTokenInfo, sources block) all observe the
				// finalized DOM state.
				throttledUpdate.cancel();
				if (!isHandleLive()) return;
				void (async (): Promise<void> => {
					await assistantHandle.updateContent(buf, { isFinal: true });
					assistantHandle.markComplete();
					if (
						meta !== undefined &&
						meta.inputTokens !== undefined &&
						meta.outputTokens !== undefined
					) {
						assistantHandle.setTokenInfo({
							input: meta.inputTokens,
							output: meta.outputTokens,
							costUsd: meta.totalCostUsd,
						});
					}
					const retrieved = session.getLastRetrieval();
					if (retrieved.length > 0) {
						// Defensive derivation: ChatSession's lazy-assistant-push
						// pattern means a zero-token stream may leave `length - 1`
						// pointing at the user msg. The role check enforces the
						// key-is-assistant-turn invariant.
						const last = session.history[session.history.length - 1];
						if (last !== undefined && last.role === 'assistant') {
							const key = makeSourcesKey(session.id, session.history.length - 1);
							renderSourcesBlock(assistantHandle, retrieved, key, host.sourcesHost);
						}
					}
				})();
			},
			onError: (err) => {
				throttledUpdate.cancel();
				const isMultiline = err.message.includes('\n');
				const firstLine = err.message.split('\n', 1)[0] ?? err.message;
				host.logger.error(
					`Stream failed: ${err.message}`,
					`Yunseul: ${firstLine}`,
				);
				if (!isHandleLive()) return;
				const content = isMultiline
					? err.message
					: `> Stream failed: ${err.message}`;
				// Same void-IIFE pattern as onComplete to serialize markComplete
				// behind the final-phase await.
				void (async (): Promise<void> => {
					await assistantHandle.updateContent(content, { isFinal: true });
					assistantHandle.markComplete();
				})();
			},
		});
	} finally {
		host.setStreaming(false);
		host.setThrottle(null);
	}
}

/**
 * Resolve a fresh BoundFileExcerpt for a session. Returns null when no
 * file is bound, or when the bound file has vanished from the vault
 * (the caller's session.boundFile is cleared as a side effect).
 */
export async function buildBoundFileExcerpt(
	app: App,
	plugin: YunseulPlugin,
	session: ChatSession,
): Promise<BoundFileExcerpt | null> {
	if (session.boundFile === null) return null;
	const af = app.vault.getAbstractFileByPath(session.boundFile.path);
	if (!(af instanceof TFile) || af !== session.boundFile) {
		plugin.logger.warn(
			`Bound file vanished: ${session.boundFile.path}`,
			'Bound note no longer exists. Sending without note context.',
		);
		session.boundFile = null;
		return null;
	}
	const content = await app.vault.cachedRead(af);
	return {
		path: af.path,
		content,
		hash: cheapHash(content),
	};
}

function appendBubble(
	app: App,
	session: ChatSession,
	msg: ChatMessage,
	isStreaming: boolean,
	host: SendControllerHost,
): BubbleHandle {
	const transcriptEl = host.getTranscriptEl();
	if (transcriptEl === null) {
		throw new Error('appendBubble called before view initialization');
	}
	const handle = renderMessageBubble(transcriptEl, msg, {
		app,
		component: host.sourcesHost.component,
		sourcePath: host.getSourcePath(session),
		isStreaming,
		allowExternalImages: host.getAllowExternalImages(),
		modelLabel: host.getModelLabel(),
		onCopy: (text) => host.onCopy(text),
		onAppend: msg.role === 'assistant' ? (text) => host.onAppend(session, text) : undefined,
		onStop: isStreaming ? () => session.stop() : undefined,
	});
	// Skip the initial updateContent for streaming assistant bubbles —
	// setThinking() owns body's contents until the first token arrives,
	// and a stray initial seed would leave MessageBubble's closure-local
	// `streamTextNode` pointing at a Text node that setThinking() then
	// detaches via body.empty(). That stale reference would trip the
	// torn-DOM guard on the first throttled onToken and drop the chunk.
	// Finalized history-restore / user bubbles still need the initial
	// render to populate their body.
	if (!isStreaming) void handle.updateContent(msg.content, { isFinal: true });
	host.scrollToBottom();
	return handle;
}

function cheapHash(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
	}
	return h.toString(16).padStart(8, '0');
}
