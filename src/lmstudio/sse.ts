// Pure SSE parser, no Obsidian dependency. Exported for direct unit
// testing under vitest. SSE framing per the spec at
// https://html.spec.whatwg.org/multipage/server-sent-events.html:
// events are separated by blank lines (two consecutive newlines after
// CRLF normalization), and within each event the lines beginning with
// `data:`, `event:`, etc. carry the payload. We intentionally stay
// minimal: most LM-Studio-style servers emit one `data:` per event and
// the terminating `data: [DONE]`. Comment lines (`:` prefix) are
// ignored per spec — LM Studio sends `: ping` keepalives.

export interface SSEEvent {
	event?: string;
	data: string;
}

export interface SSEParseResult {
	events: SSEEvent[];
	remaining: string;
}

const DONE_MARKER = '[DONE]';

export function parseSSEChunk(buffer: string): SSEParseResult {
	// Normalize line endings: \r\n → \n. SSE spec allows both forms
	// plus bare \r, but bare \r in the wild is vanishingly rare and
	// LM Studio doesn't emit it. We translate \r\n → \n and then \r → \n
	// to cover all three cases without forking the parser.
	const normalized = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

	const events: SSEEvent[] = [];
	let cursor = 0;
	let nextBoundary = normalized.indexOf('\n\n', cursor);

	while (nextBoundary !== -1) {
		const block = normalized.slice(cursor, nextBoundary);
		cursor = nextBoundary + 2;
		const parsed = parseBlock(block);
		if (parsed !== null) {
			events.push(parsed);
		}
		nextBoundary = normalized.indexOf('\n\n', cursor);
	}

	const remaining = normalized.slice(cursor);
	return { events, remaining };
}

function parseBlock(block: string): SSEEvent | null {
	if (block.length === 0) return null;
	const lines = block.split('\n');
	let eventName: string | undefined;
	const dataParts: string[] = [];

	for (const raw of lines) {
		if (raw.length === 0) continue;
		// Comment line per spec.
		if (raw.startsWith(':')) continue;
		const colonIdx = raw.indexOf(':');
		const field = colonIdx === -1 ? raw : raw.slice(0, colonIdx);
		let value = colonIdx === -1 ? '' : raw.slice(colonIdx + 1);
		// Per spec a single leading space after the colon is stripped.
		if (value.startsWith(' ')) value = value.slice(1);
		if (field === 'event') {
			eventName = value;
		} else if (field === 'data') {
			dataParts.push(value);
		}
	}

	if (dataParts.length === 0 && eventName === undefined) return null;
	const data = dataParts.join('\n');
	const out: SSEEvent = { data };
	if (eventName !== undefined) out.event = eventName;
	return out;
}

export function isDoneEvent(ev: SSEEvent): boolean {
	return ev.data.trim() === DONE_MARKER;
}
