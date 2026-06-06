// Provider abstraction for the LLM backends. The chat layer talks to
// `LLMClient`, never to a concrete backend class. Today we ship two
// implementations: `LMClient` (OpenAI-compatible HTTP + SSE, LM Studio
// is the recommended example) and `ClaudeCodeClient` (subprocess spawn
// of the local `claude` CLI). Adding a third provider in the future is
// a new module behind this interface plus a single switch arm in
// `factory.ts` — no chat-layer changes required.
//
// The interface is intentionally narrow: list models, stream a chat,
// probe the backend's health. The provider-specific details (CORS
// disambiguation, subprocess lifecycle, OAuth refresh, etc.) all live
// behind the concrete classes; the chat session and view never see
// them. `StreamCompletionMeta` is the one piece of provider leakage
// upward and it is intentionally bag-of-optionals — fields are
// populated only by providers that have a value for them.

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatRequestMessage {
	role: ChatRole;
	content: string;
}

export interface StreamCompletionMeta {
	/**
	 * Claude Code session id, captured from the first `system/init`
	 * NDJSON event of a fresh subprocess. Used by the session to
	 * continue a multi-turn conversation with `--resume <id>` on the
	 * next call. Undefined for providers that do not have a server-
	 * managed session concept (LM Studio, etc.).
	 */
	sessionId?: string;
	/**
	 * Claude Code reports a per-request cost via the `result` event.
	 * Surfaced here so the session/view can display it if desired.
	 * Undefined for providers that do not report cost.
	 */
	totalCostUsd?: number;
	/**
	 * Per-request input token count, when the provider reports it.
	 * Claude Code surfaces this via `result.usage.input_tokens`. Used by
	 * the per-bubble token meter (T2.6). Undefined for providers that
	 * do not report token usage.
	 */
	inputTokens?: number;
	/**
	 * Per-request output token count. See `inputTokens`.
	 */
	outputTokens?: number;
}

export interface StreamChatOpts {
	messages: ChatRequestMessage[];
	signal: AbortSignal;
	onToken: (token: string) => void;
	onComplete: (meta?: StreamCompletionMeta) => void;
	onError: (err: Error) => void;
	/**
	 * Provider-aware metadata callback. Fires opportunistically as the
	 * provider learns things mid-stream — Claude Code fires once on
	 * `system/init` (so sessionId can be persisted before the result
	 * arrives) and again on `result` (so totalCostUsd lands). Providers
	 * without intermediate metadata may invoke this only inside
	 * `onComplete`, or not at all.
	 */
	onMeta?: (meta: StreamCompletionMeta) => void;
	model?: string;
	temperature?: number;
	/**
	 * Provider-specific pass-through. Today's only consumer is the
	 * Claude Code client, which reads `claudeCodeSessionId` for
	 * `--resume` continuity. We intentionally type this as
	 * `Record<string, unknown>` (not `any`) so each provider hand-rolls
	 * the validator it needs.
	 */
	extras?: Record<string, unknown>;
}

export interface ProbeResult {
	ok: boolean;
	/**
	 * HTTP status (LM Studio) or process exit code (Claude Code).
	 * Optional because some failure modes have neither (network DNS
	 * failure, ENOENT on binary lookup).
	 */
	status?: number;
	message: string;
	/**
	 * Provider-specific failure kind. The set is open per provider.
	 * Known LM Studio kinds: `ok`, `offline`, `cors-blocked`,
	 * `http-error`. Known Claude Code kinds: `ok`, `not-found`,
	 * `not-logged-in`, `spawn-error`, `exit-error`.
	 */
	kind: string;
}

export interface LLMClient {
	/**
	 * Returns the list of model ids the user can pick from. Empty array
	 * means "the backend picks for us" — Claude Code returns `[]`
	 * because the model selection is governed by the user's Console /
	 * subscription rather than enumerated locally.
	 */
	listModels(): Promise<string[]>;
	streamChat(opts: StreamChatOpts): Promise<void>;
	probe(): Promise<ProbeResult>;
}
