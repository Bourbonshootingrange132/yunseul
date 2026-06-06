import type { TFile } from 'obsidian';
import type YunseulPlugin from '../main';
import type { ChatRequestMessage, StreamCompletionMeta } from '../llm/types';
import {
	PromptAssembler,
	type AssembledMessage,
	type BoundFileExcerpt,
	type ChatMessage,
	type RetrievedChunk,
} from './prompt';
import type { SessionSnapshot } from './persist';
import { tokenize } from '../index/bm25';
import type { RetrievalResult } from '../index/retriever';
import { isAbortError } from '../util/guards';

// Minimum number of tokens (post-tokenization) before we bother
// querying the retriever. Below this, BM25 against the vault is
// almost certainly noise — "hi", "thx", "ok" should not pull in
// random notes. The plan specifies > 2 tokens.
const RETRIEVAL_MIN_TOKENS = 3;

// Per-chunk character cap for retrieved-note bodies. Long notes get
// truncated so a single huge file doesn't crowd out the rest of the
// retrieved set. 2000 chars is roughly ~500 tokens and leaves room
// for several chunks under a 12k char budget.
const PER_CHUNK_MAX_CHARS = 2000;

// ChatSession owns ONLY the model-facing state: history, the bound
// file reference, and the AbortController for the in-flight stream.
// It does NOT hold any DOM references — the View subscribes via the
// callbacks the caller passes to `send()`. This separation is what
// lets us close the leaf without losing the conversation.

export interface SendContext {
	boundFileExcerpt: BoundFileExcerpt | null;
	onToken: (token: string) => void;
	// `meta` is the provider's bag-of-optionals — see StreamCompletionMeta.
	// Today this carries Claude Code's totalCostUsd (used to render a
	// token meter under the assistant bubble) and is undefined for other
	// providers. The argument is optional so legacy callers (and the 101
	// tests) that pass `() => {}` keep type-checking.
	onComplete: (meta?: StreamCompletionMeta) => void;
	onError: (err: Error) => void;
}

export class ChatSession {
	readonly id: string;
	readonly createdAt: number;
	updatedAt: number;
	boundFile: TFile | null;
	history: ChatMessage[];
	/**
	 * Server-side Claude Code session id, captured from the first
	 * `system/init` NDJSON event of the first send. Subsequent sends
	 * pass this back via `--resume <id>` so multi-turn conversations
	 * stay coherent without re-uploading history. Null on:
	 *   - fresh sessions before the first send,
	 *   - any session that hasn't talked to Claude Code yet (LM Studio
	 *     side never populates this),
	 *   - a "New chat" reset.
	 */
	claudeCodeSessionId: string | null;
	private abortCtrl: AbortController | null;
	private readonly plugin: YunseulPlugin;
	private streamingAssistantIdx: number | null;
	// Last retrieval is held in memory only — not persisted in the
	// session snapshot — because it is derived data (BM25 over current
	// vault) and re-computing it on the next user message is cheap.
	private lastRetrieval: RetrievalResult[] = [];

	constructor(plugin: YunseulPlugin, init?: Partial<SessionSnapshot>) {
		this.plugin = plugin;
		this.id = init?.id ?? makeId();
		this.createdAt = init?.createdAt ?? Date.now();
		this.updatedAt = init?.updatedAt ?? this.createdAt;
		this.history = init?.history ?? [];
		this.boundFile = null;
		this.claudeCodeSessionId = init?.claudeCodeSessionId ?? null;
		this.abortCtrl = null;
		this.streamingAssistantIdx = null;
	}

	isStreaming(): boolean {
		return this.abortCtrl !== null;
	}

	getLastRetrieval(): RetrievalResult[] {
		return this.lastRetrieval;
	}

	async send(text: string, ctx: SendContext): Promise<void> {
		if (this.isStreaming()) {
			ctx.onError(new Error('Already streaming; stop the current response first.'));
			return;
		}
		const trimmed = text.trim();
		if (trimmed.length === 0) {
			ctx.onError(new Error('Empty message.'));
			return;
		}

		const settings = this.plugin.settings;
		// LM Studio requires an explicit model id; Claude Code's CLI
		// picks its own model. We gate the no-model error path on
		// provider so claude-code users don't see a "select a model"
		// message that doesn't apply to them.
		const model = settings.lmStudio.chatModel.trim();
		if (settings.provider === 'lm-studio' && model.length === 0) {
			ctx.onError(await buildNoChatModelError(this.plugin));
			return;
		}

		// Push the user message to history so the prompt assembler sees
		// it as the latest turn. We remember the index so a failure
		// BEFORE the first token (e.g. spawn ENOENT) can pop the message
		// back off — otherwise a failed send strands the user bubble in
		// history with no assistant reply, which renders as a dangling
		// turn on reload. Once any token arrives the message is
		// "committed" and we leave it in place even on later errors.
		const userMsg: ChatMessage = { role: 'user', content: trimmed, ts: Date.now() };
		const userMsgIdx = this.history.length;
		this.history.push(userMsg);
		this.updatedAt = userMsg.ts;
		this.plugin.persistSession(this);
		let userMsgCommitted = false;
		const rollbackUserMsg = (): void => {
			if (userMsgCommitted) return;
			// Pop iff the userMsg is still where we left it. Defensive:
			// a future "edit message" feature could splice the history
			// concurrently; in that case skip the rollback rather than
			// remove someone else's entry.
			if (this.history[userMsgIdx] === userMsg) {
				this.history.splice(userMsgIdx, 1);
			}
			this.plugin.persistSession(this);
		};

		// Retrieve relevant vault notes if the retriever is online and
		// the user opted in. Non-trivial trigger: tokenize the query
		// against the BM25 tokenizer (same one the index uses) and only
		// search if at least RETRIEVAL_MIN_TOKENS terms survive.
		const retrieved = await this.maybeRetrieve(trimmed);
		this.lastRetrieval = retrieved.hits;

		const messages = PromptAssembler.build({
			boundFile: ctx.boundFileExcerpt,
			retrievedChunks: retrieved.chunks,
			history: trimRounds(this.history, settings.lmStudio.maxConversationRounds),
			maxChars: settings.lmStudio.maxContextChars,
			provider: settings.provider,
			claudeCodeWritesEnabled: settings.claudeCode.enableWrites,
		});

		const abortCtrl = new AbortController();
		this.abortCtrl = abortCtrl;
		// Assistant placeholder is appended lazily on the first token
		// so a connection failure before any token arrives doesn't
		// leave an empty assistant message in history (which would
		// restore as a blank bubble on reload).
		this.streamingAssistantIdx = null;
		// `firstTokenReceived` is the strict "is the stream actually
		// producing content?" flag. It is separate from
		// `userMsgCommitted` because Claude Code's `system/init` meta
		// event fires BEFORE any token; if the subprocess then crashes
		// the user msg should still be committed (we have evidence the
		// CLI accepted the input), but we cannot reuse the captured
		// session id because the server-side session has no recorded
		// assistant turn. Tracking these separately lets onError clear
		// `claudeCodeSessionId` in the no-token case without rolling
		// back the user msg.
		let firstTokenReceived = false;

		// Provider-specific extras. Claude Code reads this to decide
		// whether to add --resume to its argv. LM Studio ignores it.
		const extras: Record<string, unknown> = {};
		if (this.claudeCodeSessionId !== null) {
			extras.claudeCodeSessionId = this.claudeCodeSessionId;
		}

		// onMeta is the provider-neutral hook for "I learned something
		// about this stream mid-flight". Today only Claude Code uses it,
		// to surface the server-side session id before result arrives so
		// we can persist it eagerly. Receiving a meta event proves the
		// subprocess started successfully, so we mark the user message
		// as committed — but we do NOT mark `firstTokenReceived` yet
		// because no assistant content has arrived.
		const onMeta = (meta: StreamCompletionMeta): void => {
			userMsgCommitted = true;
			if (meta.sessionId !== undefined && meta.sessionId !== this.claudeCodeSessionId) {
				this.claudeCodeSessionId = meta.sessionId;
				this.plugin.persistSession(this);
			}
		};

		// Lazy-init the assistant placeholder so a failed connection
		// (before any token) doesn't leave an empty bubble in history.
		const onTokenInternal = (t: string): void => {
			// First token proves the round-trip produced assistant
			// content; commit the user message AND mark
			// `firstTokenReceived` so a downstream failure (mid-stream
			// socket drop) doesn't roll either back.
			userMsgCommitted = true;
			firstTokenReceived = true;
			if (this.streamingAssistantIdx === null) {
				const assistantMsg: ChatMessage = {
					role: 'assistant',
					content: '',
					ts: Date.now(),
				};
				this.history.push(assistantMsg);
				this.streamingAssistantIdx = this.history.length - 1;
			}
			const cur = this.history[this.streamingAssistantIdx];
			if (cur === undefined) return;
			cur.content += t;
			cur.ts = Date.now();
			ctx.onToken(t);
		};

		// The provider-neutral LLMClient.streamChat resolves either via
		// onComplete or onError (not by throwing). We translate both
		// callbacks into the SendContext shape the view expects, while
		// preserving the historical abort semantics: aborted streams
		// still resolve through ctx.onComplete with partial content
		// retained in history.
		try {
			await this.plugin.lmClient.streamChat({
				messages: toRequestMessages(messages),
				signal: abortCtrl.signal,
				model,
				temperature: settings.lmStudio.temperature,
				extras,
				onToken: onTokenInternal,
				onMeta,
				onComplete: (meta) => {
					if (meta !== undefined) onMeta(meta);
					this.updatedAt = Date.now();
					// If the stream was aborted before any token landed,
					// the claudeCodeSessionId captured from system/init
					// points at a partial server-side conversation. The
					// CLI would happily --resume from it on the next
					// send, but the conversation is in an indeterminate
					// state (half-message, possibly truncated tool use).
					// Safer to start fresh next time.
					if (abortCtrl.signal.aborted) {
						this.lastRetrieval = [];
						if (!firstTokenReceived) {
							this.claudeCodeSessionId = null;
						}
					}
					this.plugin.persistSession(this);
					ctx.onComplete(meta);
				},
				onError: (err) => {
					// If no token ever arrived, the stream failed before
					// any assistant content materialized. Two sub-cases:
					//   (a) onMeta also didn't fire — roll the user msg
					//       back (no evidence the round-trip even reached
					//       the model) AND clear the session id.
					//   (b) onMeta did fire (Claude Code captured
					//       `system/init` and we have a server-side
					//       session id) but the subprocess crashed before
					//       producing tokens — keep the user msg (CLI
					//       accepted it) but clear `claudeCodeSessionId`
					//       so the next send mints a fresh session
					//       instead of `--resume`-ing a half-state one.
					if (!userMsgCommitted) {
						rollbackUserMsg();
						this.claudeCodeSessionId = null;
					} else if (!firstTokenReceived) {
						this.claudeCodeSessionId = null;
					}
					this.lastRetrieval = [];
					this.plugin.persistSession(this);
					ctx.onError(err);
				},
			});
		} catch (e) {
			// The provider implementations route errors through
			// onError, but a bug-future-proof catch swallows anything
			// that escaped (e.g. a synchronous throw before the first
			// await). isAbortError mirrors the original semantics for
			// the rare path where AbortError bubbles up directly.
			if (isAbortError(e)) {
				this.lastRetrieval = [];
				this.updatedAt = Date.now();
				if (!firstTokenReceived) {
					this.claudeCodeSessionId = null;
				}
				this.plugin.persistSession(this);
				ctx.onComplete();
				return;
			}
			// Same two-tier logic as the onError callback above. Match
			// behavior so an error that bubbles through the catch path
			// leaves the same persisted state as one that funnels
			// through the provider's onError.
			if (!userMsgCommitted) {
				rollbackUserMsg();
				this.claudeCodeSessionId = null;
			} else if (!firstTokenReceived) {
				this.claudeCodeSessionId = null;
			}
			this.lastRetrieval = [];
			const err = e instanceof Error ? e : new Error(String(e));
			this.plugin.persistSession(this);
			ctx.onError(err);
		} finally {
			this.abortCtrl = null;
			this.streamingAssistantIdx = null;
		}
	}

	stop(): void {
		if (this.abortCtrl !== null) {
			this.abortCtrl.abort();
		}
		// Defense-in-depth: clear retrieval here too in case a caller
		// invokes stop() outside the in-flight catch path.
		this.lastRetrieval = [];
	}

	toSnapshot(): SessionSnapshot {
		return {
			id: this.id,
			createdAt: this.createdAt,
			updatedAt: this.updatedAt,
			boundFilePath: this.boundFile?.path ?? null,
			claudeCodeSessionId: this.claudeCodeSessionId,
			history: this.history.map((m) => ({ ...m })),
		};
	}

	private async maybeRetrieve(
		userText: string,
	): Promise<{ hits: RetrievalResult[]; chunks: RetrievedChunk[] }> {
		const settings = this.plugin.settings;
		const retriever = this.plugin.retriever;
		if (retriever === null) return { hits: [], chunks: [] };
		if (!settings.index.enabled) return { hits: [], chunks: [] };
		if (tokenize(userText).length < RETRIEVAL_MIN_TOKENS) return { hits: [], chunks: [] };

		// Exclude the bound file from retrieval — it's already injected
		// verbatim as the boundFile excerpt. Otherwise it would always
		// dominate scoring and we'd burn budget on a duplicate.
		const excludePaths: string[] = [];
		if (this.boundFile !== null) excludePaths.push(this.boundFile.path);

		let hits: RetrievalResult[] = [];
		try {
			hits = retriever.search(userText, {
				topK: settings.index.topK,
				excludeTags: settings.index.excludeTags,
				excludePaths,
			});
		} catch (e) {
			this.plugin.logger.warn(
				`Retrieval threw: ${e instanceof Error ? e.message : String(e)}`,
			);
			return { hits: [], chunks: [] };
		}
		if (hits.length === 0) return { hits: [], chunks: [] };

		const chunks: RetrievedChunk[] = [];
		for (const hit of hits) {
			try {
				const content = await this.plugin.app.vault.cachedRead(hit.file);
				const truncated = content.length > PER_CHUNK_MAX_CHARS
					? `${content.slice(0, PER_CHUNK_MAX_CHARS)}\n...[truncated]`
					: content;
				chunks.push({ path: hit.file.path, content: truncated, score: hit.score });
			} catch {
				// Skip unreadable files silently — the next retrieval
				// will skip them too if the read still fails.
			}
		}
		return { hits, chunks };
	}
}

function toRequestMessages(messages: AssembledMessage[]): ChatRequestMessage[] {
	// AssembledMessage is structurally compatible — but the type system
	// doesn't carry the narrowed role union from prompt.ts to client.ts
	// because they import the role definitions separately. Map
	// explicitly so the next refactor can't break the contract silently.
	return messages.map((m) => ({ role: m.role, content: m.content }));
}

function trimRounds(history: ChatMessage[], maxRounds: number): ChatMessage[] {
	// One "round" = one user message + at most one assistant message.
	// Walk from the back keeping at most `maxRounds` user messages.
	if (maxRounds <= 0) return history.slice();
	let userCount = 0;
	let cutIdx = 0;
	for (let i = history.length - 1; i >= 0; i--) {
		const m = history[i];
		if (m?.role === 'user') {
			userCount++;
			if (userCount > maxRounds) {
				cutIdx = i + 1;
				break;
			}
		}
	}
	return history.slice(cutIdx);
}

function makeId(): string {
	// crypto.randomUUID is available in all supported Obsidian versions
	// (electron >= 24). We use it directly rather than a custom UUID
	// to avoid hand-rolled collision-prone schemes.
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}
	// Fallback: short random hex string.
	return `s-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}

// Build an actionable error for the empty-chatModel case. Probes the
// local server so the user sees the exact ids they can paste. Embedding
// models are filtered out — they can't be used for chat and listing them
// just causes confusion. Falls back to generic guidance if the probe
// itself fails (server off, network blocked, etc.).
async function buildNoChatModelError(plugin: YunseulPlugin): Promise<Error> {
	let availableIds: string[] = [];
	try {
		const all = await plugin.lmClient.listModels();
		availableIds = all.filter((id) => !/embed/i.test(id));
	} catch {
		// Server probably offline — fall through to generic guidance.
	}
	const lines: string[] = ['**No chat model selected.**', ''];
	if (availableIds.length > 0) {
		lines.push('Open **Settings → Yunseul → Model** and paste one of these loaded model ids:');
		lines.push('');
		for (const id of availableIds) lines.push(`- \`${id}\``);
	} else {
		const baseUrl = plugin.settings.lmStudio.baseUrl.replace(/\/$/, '');
		lines.push(`Open **Settings → Yunseul → Model** and paste a model id from your local server.`);
		lines.push('');
		lines.push('To list loaded models:');
		lines.push('');
		lines.push('```');
		lines.push(`curl -s ${baseUrl}/models | jq '.data[].id'`);
		lines.push('```');
	}
	const err = new Error(lines.join('\n'));
	err.name = 'NoChatModelError';
	return err;
}
