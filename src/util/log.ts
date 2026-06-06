import { Notice } from 'obsidian';

// Logging facade. `debug` and `info` are no-ops unless `settings.debug`
// is on; this keeps shipped builds quiet by default and lets us turn on
// observability without recompiling. `warn`/`error` always go to the dev
// console because they correspond to real problems we want bug reports
// to surface. Both also accept an optional user-facing notice string so
// the caller can keep the surface and the log line co-located.

export interface Logger {
	debug: (...args: unknown[]) => void;
	info: (...args: unknown[]) => void;
	warn: (message: string, notice?: string, ...args: unknown[]) => void;
	error: (message: string, notice?: string, ...args: unknown[]) => void;
}

// We route everything through `console.debug` (rather than `console.log`)
// when debug mode is on, because the lint rule allows debug/warn/error
// but forbids `log`. The user-visible behavior is identical for our
// purposes.

export function makeLog(getDebug: () => boolean): Logger {
	return {
		debug: (...args: unknown[]): void => {
			if (!getDebug()) return;
			console.debug('[yunseul]', ...args);
		},
		info: (...args: unknown[]): void => {
			if (!getDebug()) return;
			console.debug('[yunseul]', ...args);
		},
		warn: (message: string, notice?: string, ...args: unknown[]): void => {
			console.warn('[yunseul]', message, ...args);
			if (notice !== undefined && notice.length > 0) {
				new Notice(notice);
			}
		},
		error: (message: string, notice?: string, ...args: unknown[]): void => {
			console.error('[yunseul]', message, ...args);
			if (notice !== undefined && notice.length > 0) {
				new Notice(notice);
			}
		},
	};
}
