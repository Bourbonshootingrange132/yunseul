import { normalizePath, type DataAdapter } from 'obsidian';
import type { ChatMessage } from './prompt';
import { makeNonce } from '../util/guards';

// Session persistence. Sessions live under
// `<configDir>/plugins/yunseul/sessions/<id>.json` so that they
// survive plugin upgrades but get cleaned up on uninstall. Writes are
// atomic — write to a `.tmp` sibling then rename. A debounced saver
// coalesces rapid token-arrival saves into one write per 2 seconds.

export interface SessionSnapshot {
	id: string;
	createdAt: number;
	updatedAt: number;
	boundFilePath: string | null;
	/**
	 * Optional. Present only after the session has streamed at least
	 * one message through the Claude Code provider. Persisted so
	 * multi-turn conversations survive plugin reload via --resume.
	 * Older snapshots written before this field existed deserialize
	 * with the field absent and ChatSession defaults it to null.
	 */
	claudeCodeSessionId?: string | null;
	history: ChatMessage[];
}

// Default kept for tests that don't have a Vault to read configDir from.
// Production callers pass `sessionsDir(plugin)` from util/paths.
// Exported so tests can reference the same path the production code
// uses, avoiding magic-string drift if the directory ever moves.
// eslint-disable-next-line obsidianmd/hardcoded-config-path -- test-only fallback; production callers pass sessionsDir(plugin) which reads vault.configDir
export const DEFAULT_SESSIONS_SUBDIR = '.obsidian/plugins/yunseul/sessions';

/**
 * Resolve the absolute path of a session file under the given sessions
 * directory. Exported so tests can build the same expected path the
 * production code writes to, instead of duplicating the join + suffix
 * logic in test fixtures.
 */
export function sessionFilePath(id: string, sessionsDir: string = DEFAULT_SESSIONS_SUBDIR): string {
	return sessionPath(sessionsDir, id);
}

// Debounce window for trailing-edge session saves. Exported so tests
// can reference the same constant instead of hardcoding magic timer
// values (e.g. 2100ms = DEBOUNCE_MS + 100 buffer).
export const DEBOUNCE_MS = 2000;

function dirPath(sessionsDir: string): string {
	return normalizePath(sessionsDir);
}

function sessionPath(sessionsDir: string, id: string): string {
	return normalizePath(`${sessionsDir}/${id}.json`);
}

function tmpPath(sessionsDir: string, id: string, nonce: string): string {
	return normalizePath(`${sessionsDir}/${id}.json.${nonce}.tmp`);
}

async function ensureDir(adapter: DataAdapter, sessionsDir: string): Promise<void> {
	const dir = dirPath(sessionsDir);
	if (!(await adapter.exists(dir))) {
		await adapter.mkdir(dir);
	}
}

export async function saveSession(
	adapter: DataAdapter,
	id: string,
	snapshot: SessionSnapshot,
	sessionsDir: string = DEFAULT_SESSIONS_SUBDIR,
): Promise<void> {
	await ensureDir(adapter, sessionsDir);
	const final = sessionPath(sessionsDir, id);
	const tmp = tmpPath(sessionsDir, id, makeNonce());
	const serialized = JSON.stringify(snapshot, null, 2);
	await adapter.write(tmp, serialized);
	// Prefer rename-over-existing where the adapter supports it; fall
	// back to remove+rename. The fallback closes a small TOCTOU window
	// but in practice the per-id in-flight chain in debouncedSaver
	// prevents concurrent writers for the same id.
	try {
		await adapter.rename(tmp, final);
	} catch (_renameErr) {
		if (await adapter.exists(final)) {
			await adapter.remove(final);
		}
		await adapter.rename(tmp, final);
	}
}

export async function loadAllSessions(
	adapter: DataAdapter,
	sessionsDir: string = DEFAULT_SESSIONS_SUBDIR,
): Promise<SessionSnapshot[]> {
	const dir = dirPath(sessionsDir);
	if (!(await adapter.exists(dir))) return [];
	const listing = await adapter.list(dir);
	const out: SessionSnapshot[] = [];
	for (const file of listing.files) {
		if (!file.endsWith('.json')) continue;
		try {
			const text = await adapter.read(file);
			const parsed: unknown = JSON.parse(text);
			if (isSessionSnapshot(parsed)) {
				out.push(parsed);
			}
		} catch (_err) {
			// Skip unreadable/corrupt session files silently — the
			// alternative is bricking the plugin on load.
		}
	}
	return out;
}

export interface DebouncedSaver {
	(id: string, snapshot: SessionSnapshot): void;
	/**
	 * Cancel pending debounce timers and write the latest snapshot for
	 * every pending id synchronously through saveSession. Awaits all
	 * writes. Safe to call multiple times. Call from plugin.onunload().
	 */
	flush: () => Promise<void>;
	/**
	 * Cancel all pending debounce timers without writing. Use when
	 * disabling the plugin and discarding unsaved state is acceptable.
	 */
	cancel: () => void;
}

export function debouncedSaver(
	adapter: DataAdapter,
	sessionsDir: string = DEFAULT_SESSIONS_SUBDIR,
): DebouncedSaver {
	// Per-session timer map so saves for different sessions don't
	// interfere. 2-second debounce matches the plan. We use
	// `window.setTimeout` so the timer is owned by the active window
	// (popout-window compatible).
	const timers = new Map<string, number>();
	// Latest snapshot per session id — keeps flush() up to date even
	// when many save() calls have come in during the debounce window.
	const pending = new Map<string, SessionSnapshot>();
	// In-flight write promise per id. New saves chain onto this promise
	// so two writes for the same id never race on the tmp/final paths.
	const inFlight = new Map<string, Promise<void>>();

	const runSave = (id: string, snapshot: SessionSnapshot): Promise<void> => {
		const prev = inFlight.get(id) ?? Promise.resolve();
		const next = prev
			.catch(() => {
				// Don't propagate an earlier failure into this attempt;
				// each write is independent. The caller already swallowed
				// the prior error.
			})
			.then(() => saveSession(adapter, id, snapshot, sessionsDir));
		// Track the in-flight promise; clear it once settled so it does
		// not leak memory for inactive sessions.
		inFlight.set(id, next);
		void next.finally(() => {
			if (inFlight.get(id) === next) {
				inFlight.delete(id);
			}
		});
		return next;
	};

	const save = ((id: string, snapshot: SessionSnapshot): void => {
		pending.set(id, snapshot);
		const existing = timers.get(id);
		if (existing !== undefined) window.clearTimeout(existing);
		const t = window.setTimeout(() => {
			timers.delete(id);
			const snap = pending.get(id);
			if (snap === undefined) return;
			pending.delete(id);
			runSave(id, snap).catch(() => {
				// Swallow — the next user action will retry. Caller
				// wires a Logger to bubble persistent failures.
			});
		}, DEBOUNCE_MS);
		timers.set(id, t);
	}) as DebouncedSaver;

	save.flush = async (): Promise<void> => {
		// Snapshot the pending set, clear timers, then await each id's
		// write chain. This guarantees the latest snapshot per id ends
		// up on disk before the returned promise resolves.
		for (const t of timers.values()) window.clearTimeout(t);
		timers.clear();
		const work: Promise<void>[] = [];
		for (const [id, snap] of pending) {
			work.push(
				runSave(id, snap).catch(() => {
					// Persistent failure on shutdown — nothing we can do.
				}),
			);
		}
		pending.clear();
		// Also drain any in-flight writes that started before flush().
		for (const p of inFlight.values()) {
			work.push(
				p.catch(() => {
					// Swallow as above.
				}),
			);
		}
		await Promise.all(work);
	};

	save.cancel = (): void => {
		for (const t of timers.values()) window.clearTimeout(t);
		timers.clear();
		pending.clear();
	};

	return save;
}

function isSessionSnapshot(x: unknown): x is SessionSnapshot {
	if (typeof x !== 'object' || x === null) return false;
	const r = x as Record<string, unknown>;
	if (typeof r.id !== 'string') return false;
	if (typeof r.createdAt !== 'number') return false;
	if (typeof r.updatedAt !== 'number') return false;
	if (r.boundFilePath !== null && typeof r.boundFilePath !== 'string') return false;
	// claudeCodeSessionId is optional. Accept undefined (older
	// snapshots), null (explicitly cleared), or a string (live).
	if (
		r.claudeCodeSessionId !== undefined &&
		r.claudeCodeSessionId !== null &&
		typeof r.claudeCodeSessionId !== 'string'
	) {
		return false;
	}
	if (!Array.isArray(r.history)) return false;
	for (const m of r.history) {
		if (typeof m !== 'object' || m === null) return false;
		const mr = m as Record<string, unknown>;
		if (mr.role !== 'system' && mr.role !== 'user' && mr.role !== 'assistant') return false;
		if (typeof mr.content !== 'string') return false;
		if (typeof mr.ts !== 'number') return false;
	}
	return true;
}
