import { requestUrl } from 'obsidian';
import type { YunseulSettings } from '../settings';
import {
	extractStreamDelta,
	isModelsResponse,
} from './types';
import { isDoneEvent, parseSSEChunk } from './sse';
import type {
	ChatRequestMessage,
	LLMClient,
	ProbeResult as LLMProbeResult,
	StreamChatOpts,
} from '../llm/types';
import { redactWithLiteralKey } from '../util/redact';
import { isAbortError } from '../util/guards';

// LMClient is the only place that talks to the local server. We do
// NOT use the `openai` npm package — the plan explains why (16 MB on
// disk, `dangerouslyAllowBrowser`, hides AbortSignal behind async
// iterators, conflates CORS errors). The constructor takes a getter
// so we always read the live settings without having to wire a
// settings-change event into every dependent.

export class LMClientError extends Error {
	readonly status?: number;
	constructor(message: string, status?: number) {
		super(message);
		this.name = 'LMClientError';
		this.status = status;
	}
}

// Re-export the chat message shape under its historical name so the
// rest of the codebase doesn't churn on the rename. The canonical
// definition lives in `../llm/types` now.
export type { ChatRequestMessage };

// Upper bound on the cumulative SSE buffer (in-progress partial events
// being assembled across chunks). Mirrors STDOUT_BUFFER_MAX in the
// Claude Code subprocess client — a misbehaving server (or one
// streaming a multi-MB payload without an `\n\n` event terminator)
// would otherwise pin the renderer thread on the parser pass. If we
// cross this cap we abandon the stream with onError; the caller's
// chat session surfaces the truncation in the bubble.
const SSE_BUFFER_MAX = 8 * 1024 * 1024;

/**
 * Internal probe result used only by LMClient. Carries the
 * CORS-vs-offline disambiguation flag the health-check wrapper needs
 * but that the cross-provider `LLMClient.probe()` does not surface
 * (different providers have different failure modes). The interface
 * client (`probe()`) returns the normalized `LLMProbeResult`; callers
 * that need the rich shape use `probeDetailed()`.
 */
export interface ProbeResultDetailed {
	ok: boolean;
	corsBlocked: boolean;
	status?: number;
	error?: string;
}

export class LMClient implements LLMClient {
	private readonly getSettings: () => YunseulSettings;

	constructor(getSettings: () => YunseulSettings) {
		this.getSettings = getSettings;
	}

	private baseUrl(): string {
		const raw = this.getSettings().lmStudio.baseUrl;
		// Strip trailing slash so callers can safely append `/models`.
		return raw.replace(/\/+$/, '');
	}

	private authHeader(): Record<string, string> {
		const key = this.getSettings().lmStudio.apiKey.trim();
		if (key.length === 0) return {};
		return { Authorization: `Bearer ${key}` };
	}

	/**
	 * Redact any literal occurrence of the configured Bearer token and
	 * common Authorization-header substrings from a string before it is
	 * surfaced to the user or the dev console. Defensive measure: some
	 * misconfigured reverse proxies (Caddy, nginx in debug) echo the
	 * Authorization header in error bodies.
	 *
	 * Delegates to the shared `util/redact.ts` so the LM Studio path
	 * and the Claude Code path use the same pattern bank; the literal
	 * apiKey is layered on top of the generic patterns here because it
	 * is the only piece of state LMClient owns that the shared util
	 * cannot know about.
	 */
	private redactSecrets(s: string): string {
		return redactWithLiteralKey(s, this.getSettings().lmStudio.apiKey);
	}

	async listModels(): Promise<string[]> {
		// We use requestUrl because /v1/models is a one-shot read and
		// requestUrl avoids the CORS preflight that trips up LM Studio
		// when the user hasn't turned CORS on.
		const url = `${this.baseUrl()}/models`;
		const res = await requestUrl({
			url,
			method: 'GET',
			headers: this.authHeader(),
			throw: false,
		});
		if (res.status < 200 || res.status >= 300) {
			throw new LMClientError(`GET /models returned HTTP ${res.status}`, res.status);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(res.text);
		} catch (_e) {
			throw new LMClientError('Server returned non-JSON for /models');
		}
		if (!isModelsResponse(parsed)) {
			throw new LMClientError('Server /models response missing data[].id');
		}
		return parsed.data.map((m) => m.id);
	}

	/**
	 * Implements `LLMClient.streamChat`. The provider-neutral interface
	 * collects model/temperature/messages into the single opts bag; we
	 * resolve sane defaults here so callers that don't set them still
	 * get a syntactically valid request. The session today always
	 * passes model and temperature, but a future caller (slash command,
	 * one-shot query) might not.
	 *
	 * `onComplete` / `onError` semantics: the LM Studio path historically
	 * surfaced completion via the resolved promise (no token loop). To
	 * match the cross-provider interface, we now invoke `onComplete` on
	 * a clean stream end and `onError` on every non-abort failure. The
	 * returned promise resolves either way so callers using
	 * `await client.streamChat(...)` still see the unified
	 * onToken/onComplete/onError flow rather than mixing exceptions with
	 * callbacks.
	 */
	async streamChat(opts: StreamChatOpts): Promise<void> {
		const url = `${this.baseUrl()}/chat/completions`;
		const settings = this.getSettings();
		const model = opts.model ?? settings.lmStudio.chatModel;
		const temperature = opts.temperature ?? settings.lmStudio.temperature;
		const body = JSON.stringify({
			model,
			messages: opts.messages,
			stream: true,
			temperature,
		});

		try {
			await this.streamChatInner(url, body, opts);
			opts.onComplete();
		} catch (e) {
			if (isAbortError(e)) {
				// User-initiated stop. The caller's onComplete contract
				// is unchanged: an aborted stream still resolves through
				// onComplete, leaving any partial content in place. The
				// session.send catch handler in chat/session.ts treats
				// abort as a non-error path, so we route through the
				// same branch here.
				opts.onComplete();
				return;
			}
			const err = e instanceof Error ? e : new Error(String(e));
			opts.onError(err);
		}
	}

	private async streamChatInner(
		url: string,
		body: string,
		opts: StreamChatOpts,
	): Promise<void> {
		let res: Response;
		try {
			// eslint-disable-next-line no-restricted-globals -- streaming SSE requires fetch's ReadableStream; requestUrl returns the full body at once
			res = await fetch(url, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Accept: 'text/event-stream',
					...this.authHeader(),
				},
				body,
				signal: opts.signal,
			});
		} catch (e) {
			// fetch throws TypeError on network/CORS failure. We can't
			// distinguish here; the caller probes via requestUrl to
			// disambiguate. Re-throw as LMClientError so handlers can
			// pattern-match.
			//
			// NARROW abort check — intentionally NOT using
			// util/guards.isAbortError. The shared helper's
			// /aborted/i message-text branch would mis-classify a network
			// failure whose body happens to contain the word "aborted"
			// (e.g. a server response "request aborted upstream") as a
			// user-initiated abort, silently converting a real error into
			// an onComplete. Restrict to the precise DOMException shape
			// that fetch + AbortController actually produce.
			if (e instanceof DOMException && e.name === 'AbortError') throw e;
			const msg = e instanceof Error ? e.message : String(e);
			throw new LMClientError(`fetch failed: ${this.redactSecrets(msg)}`);
		}

		if (!res.ok) {
			let detail = '';
			try {
				detail = await res.text();
			} catch (_e) {
				detail = '';
			}
			const safeDetail = this.redactSecrets(detail);
			throw new LMClientError(
				`HTTP ${res.status}${safeDetail ? `: ${safeDetail.slice(0, 200)}` : ''}`,
				res.status,
			);
		}

		const body0 = res.body;
		if (body0 === null) {
			throw new LMClientError('Response has no readable body');
		}
		const reader = body0.getReader();
		const decoder = new TextDecoder();
		let buf = '';

		// Idempotent cleanup. The fetch's AbortController dispatches
		// the 'abort' event independently of the read-loop unwinding,
		// so cleanup() can be invoked twice. The `cleanedUp` flag makes
		// the second call a no-op.
		let cleanedUp = false;
		const cleanup = async (): Promise<void> => {
			if (cleanedUp) return;
			cleanedUp = true;
			try {
				await reader.cancel();
			} catch (_e) {
				// ignore: cancel may throw if already closed
			}
			try {
				reader.releaseLock();
			} catch (_e) {
				// ignore: lock may already be released or a read is still pending
			}
		};

		// On abort, just request cancel — don't await, don't releaseLock
		// here. The read-loop will observe done=true and fall through to
		// the single `finally` cleanup.
		const onAbort = (): void => {
			void reader.cancel().catch(() => {
				// ignore
			});
		};
		opts.signal.addEventListener('abort', onAbort, { once: true });

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buf += decoder.decode(value, { stream: true });
				// Mirrors STDOUT_BUFFER_MAX in Claude Code: if the server
				// blasts multi-MB without an `\n\n` event boundary, abandon
				// parsing rather than spin on the partial-event accumulator.
				// Surfaced via onError with an actionable message; the
				// caller's chat session shows it in the bubble.
				if (buf.length > SSE_BUFFER_MAX) {
					throw new LMClientError('server emitted unbounded response (no SSE event terminator)');
				}
				const { events, remaining } = parseSSEChunk(buf);
				buf = remaining;
				for (const ev of events) {
					if (isDoneEvent(ev)) return;
					let json: unknown;
					try {
						json = JSON.parse(ev.data);
					} catch (_e) {
						// malformed chunk — skip silently per spec tolerance
						continue;
					}
					const token = extractStreamDelta(json);
					if (token !== null && token.length > 0) {
						opts.onToken(token);
					}
				}
			}
			// Flush any trailing decoder state, then process the final tail.
			buf += decoder.decode();
			const final = parseSSEChunk(buf);
			for (const ev of final.events) {
				if (isDoneEvent(ev)) return;
				let json: unknown;
				try {
					json = JSON.parse(ev.data);
				} catch (_e) {
					continue;
				}
				const token = extractStreamDelta(json);
				if (token !== null && token.length > 0) {
					opts.onToken(token);
				}
			}
		} finally {
			opts.signal.removeEventListener('abort', onAbort);
			await cleanup();
		}
	}

	/**
	 * Implements `LLMClient.probe`. Internally calls `probeDetailed`
	 * (which has the CORS-vs-offline split) and lifts the result into
	 * the cross-provider `LLMProbeResult` shape. The health-check
	 * wrapper at `lmstudio/health.ts` still calls `probeDetailed`
	 * directly because it needs the corsBlocked flag for actionable
	 * messages.
	 */
	async probe(): Promise<LLMProbeResult> {
		const r = await this.probeDetailed();
		if (r.ok) {
			return {
				ok: true,
				status: r.status,
				message: 'Server reachable.',
				kind: 'ok',
			};
		}
		if (r.corsBlocked) {
			return {
				ok: false,
				status: r.status,
				message: r.error ?? 'CORS blocked browser request.',
				kind: 'cors-blocked',
			};
		}
		if (typeof r.status === 'number') {
			return {
				ok: false,
				status: r.status,
				message: r.error ?? `HTTP ${r.status}`,
				kind: 'http-error',
			};
		}
		return {
			ok: false,
			message: r.error ?? 'Server unreachable.',
			kind: 'offline',
		};
	}

	async probeDetailed(): Promise<ProbeResultDetailed> {
		// Two-step probe: try fetch first (a real CORS-aware browser
		// request). If that fails with a TypeError, try requestUrl,
		// which bypasses CORS. If requestUrl succeeds but fetch failed
		// then the server is up but CORS is off — we surface that
		// specifically so the user can fix it without hunting.
		const url = `${this.baseUrl()}/models`;
		try {
			// eslint-disable-next-line no-restricted-globals -- probe intentionally compares fetch vs requestUrl to detect CORS-only failures
			const res = await fetch(url, {
				method: 'GET',
				headers: this.authHeader(),
			});
			// Drain the body so the connection doesn't sit open until GC.
			// res.body may be null on some environments; cancel is a no-op then.
			void res.body?.cancel().catch(() => {
				// ignore
			});
			if (res.ok) {
				return { ok: true, corsBlocked: false, status: res.status };
			}
			return { ok: false, corsBlocked: false, status: res.status, error: `HTTP ${res.status}` };
		} catch (fetchErr) {
			const fetchMsg = this.redactSecrets(
				fetchErr instanceof Error ? fetchErr.message : String(fetchErr),
			);
			try {
				const res2 = await requestUrl({ url, method: 'GET', headers: this.authHeader(), throw: false });
				if (res2.status >= 200 && res2.status < 300) {
					return {
						ok: false,
						corsBlocked: true,
						status: res2.status,
						error: `fetch failed (${fetchMsg}); requestUrl succeeded`,
					};
				}
				// requestUrl returned a non-2xx response — server is up
				// but the auth/path is wrong AND CORS is off. Surface both.
				return {
					ok: false,
					corsBlocked: true,
					status: res2.status,
					error: `requestUrl returned HTTP ${res2.status}; CORS also blocked browser fetch (${fetchMsg})`,
				};
			} catch (urlErr) {
				const urlMsg = this.redactSecrets(
					urlErr instanceof Error ? urlErr.message : String(urlErr),
				);
				return {
					ok: false,
					corsBlocked: false,
					error: `Server unreachable: ${urlMsg}`,
				};
			}
		}
	}
}

