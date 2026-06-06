import { describe, expect, it } from 'vitest';
import { isDoneEvent, parseSSEChunk } from '../src/lmstudio/sse';

describe('parseSSEChunk', () => {
	it('parses a single complete event', () => {
		const { events, remaining } = parseSSEChunk('data: hello\n\n');
		expect(events).toEqual([{ data: 'hello' }]);
		expect(remaining).toBe('');
	});

	it('handles multi-chunk reassembly across blank-line boundary', () => {
		// Split the boundary so the first call has no complete events.
		const first = parseSSEChunk('data: hello\n');
		expect(first.events).toEqual([]);
		expect(first.remaining).toBe('data: hello\n');

		const second = parseSSEChunk(`${first.remaining}\n`);
		expect(second.events).toEqual([{ data: 'hello' }]);
		expect(second.remaining).toBe('');
	});

	it('normalizes CRLF line endings', () => {
		const { events, remaining } = parseSSEChunk('data: hi\r\n\r\n');
		expect(events).toEqual([{ data: 'hi' }]);
		expect(remaining).toBe('');
	});

	it('preserves a partial JSON payload across reads', () => {
		const part1 = parseSSEChunk('data: {"choices":[{"delta":');
		expect(part1.events).toEqual([]);
		const part2 = parseSSEChunk(`${part1.remaining}{"content":"hi"}}]}\n\n`);
		expect(part2.events).toHaveLength(1);
		expect(part2.events[0]?.data).toContain('"content":"hi"');
	});

	it('detects [DONE] terminator via helper', () => {
		const { events } = parseSSEChunk('data: [DONE]\n\n');
		expect(events).toHaveLength(1);
		const first = events[0];
		expect(first).toBeDefined();
		if (first === undefined) return;
		expect(isDoneEvent(first)).toBe(true);
	});

	it('returns malformed-looking events for the caller to skip without crashing', () => {
		// The parser itself does NOT validate JSON inside `data:` — it
		// only frames events. The caller's `JSON.parse(...)` decides.
		// We assert: a malformed `data:` does not corrupt subsequent
		// events.
		const { events } = parseSSEChunk(
			'data: not json\n\ndata: {"ok":1}\n\n',
		);
		expect(events).toHaveLength(2);
		expect(events[0]?.data).toBe('not json');
		expect(events[1]?.data).toBe('{"ok":1}');
	});

	it('handles UTF-8 multi-byte sequence split across chunks via decoder', () => {
		// The TextDecoder side of the boundary is exercised in
		// client.ts directly; for the pure parser we assert that
		// arbitrary UTF-8 characters survive intact.
		const { events } = parseSSEChunk('data: emoji ☃ snowman\n\n');
		expect(events).toHaveLength(1);
		expect(events[0]?.data).toBe('emoji ☃ snowman');
	});

	it('ignores comment lines starting with a colon', () => {
		const { events } = parseSSEChunk(': keepalive\n\n');
		expect(events).toEqual([]);
	});

	it('handles a comment interleaved with data', () => {
		const { events } = parseSSEChunk(
			':ka\ndata: payload\n\n',
		);
		expect(events).toHaveLength(1);
		expect(events[0]?.data).toBe('payload');
	});

	it('joins multiple data: lines with a single newline', () => {
		const { events } = parseSSEChunk('data: a\ndata: b\n\n');
		expect(events).toHaveLength(1);
		expect(events[0]?.data).toBe('a\nb');
	});

	it('parses named events with an event: field', () => {
		const { events } = parseSSEChunk('event: ping\ndata: {}\n\n');
		expect(events).toHaveLength(1);
		expect(events[0]?.event).toBe('ping');
		expect(events[0]?.data).toBe('{}');
	});
});
