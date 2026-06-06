import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { throttle } from '../src/util/throttle';

// throttle() is the leading + trailing UI throttle that drives 30fps
// streaming render in MessageBubble. Tests use fake timers so the
// trailing-call window is fully deterministic.

describe('throttle', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('invokes the function immediately on the first call (leading edge)', () => {
		const calls: number[] = [];
		const fn = throttle((n: number): void => {
			calls.push(n);
		}, 100);
		fn(1);
		expect(calls).toEqual([1]);
	});

	it('coalesces rapid calls within the window and fires once trailing with the latest args', () => {
		const calls: number[] = [];
		const fn = throttle((n: number): void => {
			calls.push(n);
		}, 100);
		fn(1);
		expect(calls).toEqual([1]);
		// All subsequent calls within the 100ms window should be coalesced.
		vi.advanceTimersByTime(20);
		fn(2);
		vi.advanceTimersByTime(20);
		fn(3);
		vi.advanceTimersByTime(20);
		fn(4);
		// Nothing fired yet — still within the trailing window.
		expect(calls).toEqual([1]);
		// Now advance past the trailing timer. Only the latest args fire.
		vi.advanceTimersByTime(100);
		expect(calls).toEqual([1, 4]);
	});

	it('cancel() prevents pending trailing call from firing', () => {
		const calls: number[] = [];
		const fn = throttle((n: number): void => {
			calls.push(n);
		}, 100);
		fn(1);
		fn(2); // queued as trailing
		fn(3); // overrides queued
		fn.cancel();
		vi.advanceTimersByTime(500);
		expect(calls).toEqual([1]);
	});

	it('treats next call as leading again after the window passes idle', () => {
		const calls: number[] = [];
		const fn = throttle((n: number): void => {
			calls.push(n);
		}, 100);
		fn(1);
		expect(calls).toEqual([1]);
		// Advance well past the throttle window with no activity.
		vi.advanceTimersByTime(500);
		// Next call should be immediate again (leading edge).
		fn(2);
		expect(calls).toEqual([1, 2]);
	});
});
