// Leading + trailing edge throttle.
// Calls fn immediately on the first invocation; subsequent calls within
// the window are coalesced into a single trailing invocation that fires
// `ms` after the most recent call. This is the classic UI throttle shape
// used for high-frequency token streams. Uses `window.setTimeout` so
// the timer belongs to the active window (popout-window compatible).

export interface ThrottledFn<A extends unknown[]> {
	(...args: A): void;
	/** Cancel any pending trailing call. Safe to call repeatedly. */
	cancel: () => void;
}

export function throttle<A extends unknown[]>(
	fn: (...args: A) => void,
	ms: number,
): ThrottledFn<A> {
	let last = 0;
	let pendingArgs: A | null = null;
	let timer: number | null = null;

	const invoke = (args: A): void => {
		last = Date.now();
		pendingArgs = null;
		fn(...args);
	};

	const throttled = ((...args: A): void => {
		const now = Date.now();
		const elapsed = now - last;
		if (elapsed >= ms) {
			if (timer !== null) {
				window.clearTimeout(timer);
				timer = null;
			}
			invoke(args);
			return;
		}
		pendingArgs = args;
		if (timer === null) {
			timer = window.setTimeout(() => {
				timer = null;
				if (pendingArgs !== null) {
					invoke(pendingArgs);
				}
			}, ms - elapsed);
		}
	}) as ThrottledFn<A>;

	throttled.cancel = (): void => {
		if (timer !== null) {
			window.clearTimeout(timer);
			timer = null;
		}
		pendingArgs = null;
	};

	return throttled;
}
