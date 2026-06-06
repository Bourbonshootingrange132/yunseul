// NDJSON line-buffer + stream-event parser for the Claude Code CLI's
// `--output-format stream-json` mode.
//
// The CLI emits exactly one JSON value per \n-terminated line on stdout.
// JSON strings inside the value JSON-escape their newlines as `\n`
// (literal backslash-n), so a raw `\n` byte unambiguously marks a line
// boundary. We accumulate partial lines across chunks and parse on
// every newline.
//
// Pure module — no logger/Notice imports. Every user-visible surface
// (warnings, debug traces, api_retry Notice, the streaming token/meta
// surface) is injected as a callback by the orchestrator (client.ts) so
// this file can be unit-tested in isolation and the orchestrator can
// wire each callback to its preferred surface.

import { isObject } from '../util/guards';
import { STDOUT_BUFFER_MAX, STDOUT_LINE_MAX } from './constants';

/**
 * Callbacks fired by the NDJSON parser as it encounters known event
 * types. The orchestrator wires each one to the appropriate downstream:
 *   - onText → opts.onToken
 *   - onSystemInit → meta.sessionId = sid + opts.onMeta?.({sessionId: sid})
 *   - onResult → meta merge + opts.onMeta?.({...meta})
 *   - onApiRetry → optional Notice + plugin.logger.warn
 *   - warn / debug → plugin.logger.warn / .debug
 *
 * `warn` and `debug` are callbacks (not direct imports of the logger)
 * because the existing tests stub plugin.logger.warn AFTER construction
 * (claude-code.test.ts:1011, 1040, 1070, 1109). A naive `const warn =
 * plugin.logger.warn` captured at construction time would miss those
 * later stubs and silently fail the assertion. The orchestrator passes
 * `(m) => this.plugin.logger.warn(m)` so the lookup is fresh per call.
 */
export interface NdjsonHandlers {
	onText: (text: string) => void;
	onSystemInit: (sessionId: string) => void;
	onResult: (event: ResultEvent) => void;
	onApiRetry: (attempt: number | undefined) => void;
	warn: (msg: string) => void;
	debug: (msg: string) => void;
}

/**
 * Normalized payload of a `type=result` event after the parser has
 * pulled out the fields we care about. Any field may be undefined if the
 * CLI didn't emit it (forward compat with older / newer versions).
 */
export interface ResultEvent {
	sessionId: string | undefined;
	totalCostUsd: number | undefined;
	inputTokens: number | undefined;
	outputTokens: number | undefined;
}

/**
 * Buffer NDJSON chunks across stdout boundaries and dispatch one parse
 * call per complete line. The buffer tolerates Windows `\r\n` boundaries
 * via downstream trim(); drops oversize lines (> STDOUT_LINE_MAX) with a
 * debug log; abandons the buffer entirely (with a warn) if the running
 * partial line crosses STDOUT_BUFFER_MAX without a newline.
 *
 * The buffer is single-threaded per process (one instance per
 * runSubprocess call). Callers must invoke push() on every stdout data
 * event and flush() exactly once when the stream closes — flush() walks
 * any final un-newlined trailing line.
 */
export class NdjsonBuffer {
	private buf = '';
	private readonly decoder = new TextDecoder();
	private readonly handlers: NdjsonHandlers;
	private closed = false;

	constructor(handlers: NdjsonHandlers) {
		this.handlers = handlers;
	}

	/**
	 * Push one stdout chunk into the buffer. Dispatches one parseStreamLine
	 * call per complete \n-terminated line. Fires events in-loop (not
	 * batched) so onText / onResult interleave in the same order the CLI
	 * emitted them — critical for the regression test that asserts
	 * `tokens.equal(['Hello', ' world'])` on multi-chunk dispatch.
	 */
	push(chunk: Buffer | string): void {
		if (this.closed) return;
		const text = typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
		this.buf += text;
		if (this.buf.length > STDOUT_BUFFER_MAX) {
			// Runaway upstream — abandon the buffer rather than stall
			// the renderer. The close handler will surface a non-zero
			// exit if the CLI eventually quits.
			this.handlers.warn('claude-code: stdout buffer exceeded cap; discarding');
			this.buf = '';
			return;
		}
		let newlineIdx = this.buf.indexOf('\n');
		while (newlineIdx !== -1) {
			// Tolerate Windows `\r\n` boundaries — trim() below will
			// strip the stray CR.
			const rawLine = this.buf.slice(0, newlineIdx);
			this.buf = this.buf.slice(newlineIdx + 1);
			const line = rawLine.trim();
			if (line.length > 0 && line.length <= STDOUT_LINE_MAX) {
				parseStreamLine(line, this.handlers);
			} else if (line.length > STDOUT_LINE_MAX) {
				this.handlers.debug(
					`claude-code: dropping oversize stdout line (${line.length} chars)`,
				);
			}
			newlineIdx = this.buf.indexOf('\n');
		}
	}

	/**
	 * Flush any trailing partial line that did not end with a newline.
	 * Idempotent — subsequent calls are no-ops. Called once on the close
	 * event so a CLI that exits without flushing its final line still
	 * dispatches the final event.
	 */
	flush(): void {
		if (this.closed) return;
		this.closed = true;
		this.buf += this.decoder.decode();
		const tail = this.buf.trim();
		this.buf = '';
		if (tail.length > 0 && tail.length <= STDOUT_LINE_MAX) {
			parseStreamLine(tail, this.handlers);
		}
	}
}

/**
 * Parse one NDJSON line from the CLI's stdout and dispatch the event.
 * Unknown event types are ignored — we want forward-compat with new CLI
 * events without crashing.
 *
 * Event types we intentionally ignore: `tool_use`, `tool_result`,
 * `message_start`, `message_delta`, `content_block_start`,
 * `content_block_stop`. The current chat surface only renders the text
 * deltas; tool calls are handled by the CLI itself and we don't surface
 * them in the bubble.
 */
export function parseStreamLine(line: string, handlers: NdjsonHandlers): void {
	let event: unknown;
	try {
		event = JSON.parse(line);
	} catch (_e) {
		// Skip malformed lines silently — defensive against the CLI
		// emitting a non-JSON warning that escaped stderr.
		handlers.debug(`claude-code: dropping non-JSON line: ${line.slice(0, 100)}`);
		return;
	}
	if (!isObject(event)) return;

	const type = stringOrUndef(event.type);
	const subtype = stringOrUndef(event.subtype);

	if (type === 'system' && subtype === 'init') {
		const sid = stringOrUndef(event.session_id);
		if (sid !== undefined) {
			handlers.onSystemInit(sid);
		}
		return;
	}

	if (type === 'system' && subtype === 'api_retry') {
		const attempt = typeof event.attempt === 'number' ? event.attempt : undefined;
		handlers.onApiRetry(attempt);
		return;
	}

	if (type === 'stream_event') {
		const inner = event.event;
		if (!isObject(inner)) return;
		if (inner.type !== 'content_block_delta') return;
		const delta = inner.delta;
		if (!isObject(delta)) return;
		if (delta.type !== 'text_delta') return;
		const text = stringOrUndef(delta.text);
		if (text !== undefined && text.length > 0) {
			handlers.onText(text);
		}
		return;
	}

	if (type === 'result') {
		const cost = typeof event.total_cost_usd === 'number' ? event.total_cost_usd : undefined;
		const sid = stringOrUndef(event.session_id);
		// Token counts are nested under `result.usage` on Claude Code's
		// NDJSON. Guard each field separately — older CLI versions may
		// omit one or both.
		const usage = isObject(event.usage) ? event.usage : undefined;
		const inputTokens = usage !== undefined && typeof usage.input_tokens === 'number'
			? usage.input_tokens
			: undefined;
		const outputTokens = usage !== undefined && typeof usage.output_tokens === 'number'
			? usage.output_tokens
			: undefined;
		handlers.onResult({
			sessionId: sid,
			totalCostUsd: cost,
			inputTokens,
			outputTokens,
		});
		return;
	}

	// Tool-use events and other types: ignore by design. The CLI
	// handles them; we'd only surface them when we add UI for it.
}

function stringOrUndef(x: unknown): string | undefined {
	return typeof x === 'string' ? x : undefined;
}
