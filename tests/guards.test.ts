import { describe, expect, it } from 'vitest';
import { isAbortError, isObject, makeNonce } from '../src/util/guards';

// Coverage for the shared `util/guards.ts` extracted in audit Arch1.
// Each helper used to be duplicated across 5 modules; consolidating them
// removed the drift hazard where one path's isAbortError handled
// DOMException but another path's didn't. These tests pin the BROADEST
// semantics that the consolidation adopted, so re-narrowing a path is
// caught immediately.

describe('isObject', () => {
	it('returns true for a plain object literal', () => {
		expect(isObject({})).toBe(true);
		expect(isObject({ a: 1 })).toBe(true);
	});

	it('returns false for null (which has typeof "object")', () => {
		expect(isObject(null)).toBe(false);
	});

	it('returns false for primitive values', () => {
		expect(isObject(undefined)).toBe(false);
		expect(isObject(0)).toBe(false);
		expect(isObject('hello')).toBe(false);
		expect(isObject(true)).toBe(false);
	});

	it('returns true for arrays (typeof === "object")', () => {
		// Callers that need to exclude arrays use Array.isArray separately;
		// isObject's contract is the looser "non-null object" check that
		// matches the previous duplicated implementations.
		expect(isObject([])).toBe(true);
		expect(isObject([1, 2, 3])).toBe(true);
	});

	it('narrows the type so the consumer can index safely', () => {
		const v: unknown = { type: 'system', subtype: 'init' };
		if (isObject(v)) {
			// Type assertion: indexable Record<string, unknown>.
			expect(typeof v.type).toBe('string');
		}
	});
});

describe('isAbortError', () => {
	it('returns true for DOMException with name AbortError', () => {
		const e = new DOMException('aborted', 'AbortError');
		expect(isAbortError(e)).toBe(true);
	});

	it('returns true for Error with name AbortError', () => {
		const e = new Error('cancelled');
		e.name = 'AbortError';
		expect(isAbortError(e)).toBe(true);
	});

	it('returns true for Error whose message matches /aborted/i (defensive)', () => {
		// Some adapters surface aborts via plaintext message rather than via
		// the standard name; the broadest variant accepts both.
		const e = new Error('request was aborted by user');
		expect(isAbortError(e)).toBe(true);
	});

	it('returns false for unrelated Error types', () => {
		expect(isAbortError(new Error('timeout'))).toBe(false);
		expect(isAbortError(new TypeError('bad shape'))).toBe(false);
	});

	it('returns false for non-Error values', () => {
		expect(isAbortError(undefined)).toBe(false);
		expect(isAbortError(null)).toBe(false);
		expect(isAbortError('AbortError')).toBe(false);
		expect(isAbortError({ name: 'AbortError' })).toBe(false);
	});
});

describe('makeNonce', () => {
	it('returns a non-empty string', () => {
		const n = makeNonce();
		expect(typeof n).toBe('string');
		expect(n.length).toBeGreaterThan(0);
	});

	it('returns a different value on each call (cryptographic uniqueness)', () => {
		const a = makeNonce();
		const b = makeNonce();
		expect(a).not.toBe(b);
	});

	it('returns a UUID-shaped value', () => {
		// crypto.randomUUID() always returns the 8-4-4-4-12 hex format.
		// Pinning the shape here catches a future swap to a weaker scheme
		// (Math.random fallback, hex slice) which would reintroduce the
		// collision-paradox window the consolidation closed.
		const n = makeNonce();
		expect(n).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	});
});
