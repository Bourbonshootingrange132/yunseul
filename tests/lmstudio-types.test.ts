import { describe, expect, it } from 'vitest';
import {
	extractStreamDelta,
	isModelEntry,
	isModelsResponse,
} from '../src/lmstudio/types';

// Narrow defensive validators for LM Studio / OpenAI-compatible payloads.
// We assert each guard tolerates the well-formed payload shape and rejects
// every plausible malformed shape (null, wrong-typed inner field).

describe('isModelsResponse', () => {
	it('accepts a valid {data:[{id:string}]} payload', () => {
		expect(isModelsResponse({ data: [{ id: 'gpt-4o-mini' }] })).toBe(true);
	});

	it('rejects {data: "wrong"} (data must be an array)', () => {
		expect(isModelsResponse({ data: 'wrong' })).toBe(false);
	});

	it('rejects null', () => {
		expect(isModelsResponse(null)).toBe(false);
	});

	it('rejects an entry missing the id field', () => {
		expect(isModelsResponse({ data: [{ name: 'x' }] })).toBe(false);
	});

	it('accepts an empty data array (server with no model loaded)', () => {
		expect(isModelsResponse({ data: [] })).toBe(true);
	});
});

describe('isModelEntry', () => {
	it('accepts the minimal {id:string} shape', () => {
		expect(isModelEntry({ id: 'llama-3.1-8b' })).toBe(true);
	});

	it('tolerates extra fields (LM Studio/Ollama add their own keys)', () => {
		expect(isModelEntry({ id: 'm', state: 'loaded', digest: 'abc' })).toBe(true);
	});

	it('rejects id being a number', () => {
		expect(isModelEntry({ id: 42 })).toBe(false);
	});

	it('rejects null', () => {
		expect(isModelEntry(null)).toBe(false);
	});
});

describe('extractStreamDelta', () => {
	it('returns the content string from a valid stream chunk', () => {
		const chunk = {
			choices: [{ delta: { content: 'Hello' } }],
		};
		expect(extractStreamDelta(chunk)).toBe('Hello');
	});

	it('returns null when choices[0].delta.content is missing', () => {
		const chunk = { choices: [{ delta: {} }] };
		expect(extractStreamDelta(chunk)).toBeNull();
	});

	it('returns null when choices is empty', () => {
		expect(extractStreamDelta({ choices: [] })).toBeNull();
	});

	it('returns null on null input', () => {
		expect(extractStreamDelta(null)).toBeNull();
	});
});
