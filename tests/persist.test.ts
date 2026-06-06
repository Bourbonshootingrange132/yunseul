import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataAdapter, ListedFiles, Stat } from 'obsidian';
import {
	DEBOUNCE_MS,
	debouncedSaver,
	loadAllSessions,
	saveSession,
	sessionFilePath,
	type SessionSnapshot,
} from '../src/chat/persist';

interface Op {
	kind: string;
	path: string;
}

class MemoryAdapter implements DataAdapter {
	files = new Map<string, string>();
	ops: Op[] = [];

	getName(): string {
		return 'memory';
	}

	async exists(p: string): Promise<boolean> {
		this.ops.push({ kind: 'exists', path: p });
		if (this.files.has(p)) return true;
		// Directory existence: treat as existing if any child has this prefix.
		for (const k of this.files.keys()) {
			if (k.startsWith(`${p}/`)) return true;
		}
		return false;
	}

	async stat(_p: string): Promise<Stat | null> {
		return null;
	}

	async list(p: string): Promise<ListedFiles> {
		const files: string[] = [];
		const prefix = p.endsWith('/') ? p : `${p}/`;
		for (const k of this.files.keys()) {
			if (k.startsWith(prefix)) {
				const rest = k.slice(prefix.length);
				if (!rest.includes('/')) files.push(k);
			}
		}
		return { files, folders: [] };
	}

	async read(p: string): Promise<string> {
		const v = this.files.get(p);
		if (v === undefined) throw new Error(`not found: ${p}`);
		return v;
	}

	async readBinary(_p: string): Promise<ArrayBuffer> {
		throw new Error('not impl');
	}

	async write(p: string, data: string): Promise<void> {
		this.ops.push({ kind: 'write', path: p });
		this.files.set(p, data);
	}

	async writeBinary(): Promise<void> {
		throw new Error('not impl');
	}

	async append(_p: string, _d: string): Promise<void> {
		throw new Error('not impl');
	}

	async appendBinary(): Promise<void> {
		throw new Error('not impl');
	}

	async process(): Promise<string> {
		throw new Error('not impl');
	}

	getResourcePath(p: string): string {
		return p;
	}

	async mkdir(p: string): Promise<void> {
		this.ops.push({ kind: 'mkdir', path: p });
		// Directories are implicit in the in-memory map; no-op other
		// than recording the operation for assertions.
	}

	async trashSystem(): Promise<boolean> {
		return true;
	}

	async trashLocal(): Promise<void> {
		return;
	}

	async rmdir(): Promise<void> {
		return;
	}

	async remove(p: string): Promise<void> {
		this.ops.push({ kind: 'remove', path: p });
		this.files.delete(p);
	}

	async rename(from: string, to: string): Promise<void> {
		this.ops.push({ kind: 'rename', path: `${from} -> ${to}` });
		const v = this.files.get(from);
		if (v === undefined) throw new Error(`rename: source missing ${from}`);
		this.files.set(to, v);
		this.files.delete(from);
	}

	async copy(): Promise<void> {
		throw new Error('not impl');
	}
}

const sampleSnapshot = (id: string): SessionSnapshot => ({
	id,
	createdAt: 100,
	updatedAt: 200,
	boundFilePath: 'Notes/foo.md',
	history: [{ role: 'user', content: 'hi', ts: 150 }],
});

describe('saveSession', () => {
	it('writes to a .tmp path then renames atomically', async () => {
		const adapter = new MemoryAdapter();
		await saveSession(adapter, 'abc', sampleSnapshot('abc'));
		// Filter on the specific predicates rather than `indexOf('write')`
		// — indexOf would pick up a stray sidecar write (e.g. a future
		// manifest) and the test would silently pass for the wrong reason.
		const writeIdx = adapter.ops.findIndex(
			(o) => o.kind === 'write' && o.path.endsWith('.tmp'),
		);
		const renameIdx = adapter.ops.findIndex(
			(o) => o.kind === 'rename' && o.path.endsWith('abc.json'),
		);
		expect(writeIdx).toBeGreaterThan(-1);
		expect(renameIdx).toBeGreaterThan(writeIdx);
	});

	it('overwrites an existing session file via rename (with delete-then-rename fallback)', async () => {
		const adapter = new MemoryAdapter();
		await saveSession(adapter, 'abc', sampleSnapshot('abc'));
		adapter.ops.length = 0;
		await saveSession(adapter, 'abc', { ...sampleSnapshot('abc'), updatedAt: 999 });
		const kinds = adapter.ops.map((o) => o.kind);
		// The new strategy prefers rename-over-existing where supported.
		// The MemoryAdapter overwrites silently so no remove is needed.
		expect(kinds).toContain('rename');
		// And the final file reflects the new content. Use the exported
		// path helper so the test stays in sync if the directory layout
		// ever moves.
		const finalPath = sessionFilePath('abc');
		const text = adapter.files.get(finalPath);
		expect(text).toBeDefined();
		expect(JSON.parse(text!).updatedAt).toBe(999);
	});

	it('falls back to remove+rename when rename throws on existing destination', async () => {
		const adapter = new MemoryAdapter();
		// Install a strict rename: throw when destination already exists.
		const origRename = adapter.rename.bind(adapter);
		adapter.rename = async (from: string, to: string): Promise<void> => {
			if (adapter.files.has(to)) {
				adapter.ops.push({ kind: 'rename-throw', path: `${from} -> ${to}` });
				throw new Error('destination exists');
			}
			return origRename(from, to);
		};
		await saveSession(adapter, 'abc', sampleSnapshot('abc'));
		adapter.ops.length = 0;
		await saveSession(adapter, 'abc', { ...sampleSnapshot('abc'), updatedAt: 999 });
		const kinds = adapter.ops.map((o) => o.kind);
		expect(kinds).toContain('remove');
		expect(kinds).toContain('rename');
	});

	it('creates the sessions dir if missing', async () => {
		const adapter = new MemoryAdapter();
		await saveSession(adapter, 'abc', sampleSnapshot('abc'));
		const kinds = adapter.ops.map((o) => o.kind);
		expect(kinds).toContain('mkdir');
	});
});

describe('loadAllSessions', () => {
	it('returns [] when the sessions dir does not exist', async () => {
		const adapter = new MemoryAdapter();
		const out = await loadAllSessions(adapter);
		expect(out).toEqual([]);
	});

	it('loads previously-saved sessions and skips corrupt files', async () => {
		const adapter = new MemoryAdapter();
		await saveSession(adapter, 'one', sampleSnapshot('one'));
		await saveSession(adapter, 'two', sampleSnapshot('two'));
		adapter.files.set('.obsidian/plugins/yunseul/sessions/corrupt.json', '{not json');
		const out = await loadAllSessions(adapter);
		const ids = out.map((s) => s.id).sort();
		expect(ids).toEqual(['one', 'two']);
	});
});

describe('debouncedSaver', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('coalesces rapid writes into a single save after the 2s window', async () => {
		const adapter = new MemoryAdapter();
		const save = debouncedSaver(adapter);
		const snap = sampleSnapshot('abc');
		save('abc', snap);
		save('abc', { ...snap, updatedAt: 300 });
		save('abc', { ...snap, updatedAt: 400 });

		expect(adapter.ops.filter((o) => o.kind === 'write')).toHaveLength(0);
		// DEBOUNCE_MS + 100ms buffer so we land just past the trailing edge.
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 100);
		const writes = adapter.ops.filter((o) => o.kind === 'write');
		expect(writes).toHaveLength(1);
	});

	it('debounces independently per session id', async () => {
		const adapter = new MemoryAdapter();
		const save = debouncedSaver(adapter);
		save('a', sampleSnapshot('a'));
		save('b', sampleSnapshot('b'));
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 100);
		const writes = adapter.ops.filter((o) => o.kind === 'write');
		expect(writes).toHaveLength(2);
	});

	it('flush() writes the latest pending snapshot synchronously without waiting for the debounce window', async () => {
		const adapter = new MemoryAdapter();
		const save = debouncedSaver(adapter);
		save('abc', sampleSnapshot('abc'));
		save('abc', { ...sampleSnapshot('abc'), updatedAt: 999 });
		// Critically: we do NOT advance timers — flush should not depend
		// on the trailing setTimeout firing.
		await save.flush();
		const writes = adapter.ops.filter((o) => o.kind === 'write');
		expect(writes).toHaveLength(1);
		// The latest snapshot landed on disk.
		const finalPath = sessionFilePath('abc');
		const text = adapter.files.get(finalPath);
		expect(text).toBeDefined();
		expect(JSON.parse(text!).updatedAt).toBe(999);
	});

	it('flush() drains pending writes for multiple ids', async () => {
		const adapter = new MemoryAdapter();
		const save = debouncedSaver(adapter);
		save('a', sampleSnapshot('a'));
		save('b', sampleSnapshot('b'));
		save('c', sampleSnapshot('c'));
		await save.flush();
		const writes = adapter.ops.filter((o) => o.kind === 'write');
		expect(writes).toHaveLength(3);
	});

	it('cancel() suppresses pending writes (no disk activity after the window)', async () => {
		const adapter = new MemoryAdapter();
		const save = debouncedSaver(adapter);
		save('abc', sampleSnapshot('abc'));
		save.cancel();
		// Advance well past the debounce window to prove cancel() truly
		// suppressed any trailing-edge write, not just delayed it.
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2 + 100);
		const writes = adapter.ops.filter((o) => o.kind === 'write');
		expect(writes).toHaveLength(0);
	});

	it('cancel() is safe to call when no pending writes exist', async () => {
		const adapter = new MemoryAdapter();
		const save = debouncedSaver(adapter);
		// No save() calls — cancel() should be a no-op that does not throw.
		expect(() => save.cancel()).not.toThrow();
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 100);
		expect(adapter.ops.filter((o) => o.kind === 'write')).toHaveLength(0);
	});

	// Audit T1: flush/cancel onunload-path coverage. Each test below maps
	// 1:1 to a hazard the audit flagged as untested.

	it('flush() resolves only after all in-flight saves complete', async () => {
		// Slow the underlying writes so we can observe flush() waiting on
		// them. We measure success by ordering: flush() resolves AFTER
		// every adapter.write completes (so its `await flush()` is a real
		// onunload barrier).
		const adapter = new MemoryAdapter();
		const writeOrder: string[] = [];
		const origWrite = adapter.write.bind(adapter);
		adapter.write = async (p: string, d: string): Promise<void> => {
			// Yield two microtasks so any same-tick "flush returned early"
			// bug would be observable.
			await Promise.resolve();
			await Promise.resolve();
			writeOrder.push(p);
			return origWrite(p, d);
		};
		const save = debouncedSaver(adapter);
		save('a', sampleSnapshot('a'));
		save('b', sampleSnapshot('b'));
		await save.flush();
		// All writes happened BEFORE flush resolved (otherwise the array
		// would be empty / partial).
		const writes = adapter.ops.filter((o) => o.kind === 'write');
		expect(writes).toHaveLength(2);
		expect(writeOrder).toHaveLength(2);
	});

	it('flush() is idempotent — calling twice does not throw or double-write', async () => {
		const adapter = new MemoryAdapter();
		const save = debouncedSaver(adapter);
		save('abc', sampleSnapshot('abc'));
		await save.flush();
		// Second flush() with no work pending should resolve to a no-op
		// (no extra disk activity) and not throw.
		await save.flush();
		const writes = adapter.ops.filter((o) => o.kind === 'write');
		expect(writes).toHaveLength(1);
	});

	it('cancel() preempts the trailing debounce — no late write fires after cancel', async () => {
		const adapter = new MemoryAdapter();
		const save = debouncedSaver(adapter);
		save('abc', sampleSnapshot('abc'));
		// Advance just past half the debounce window so a stale timer
		// would still be live, then cancel.
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS / 2);
		save.cancel();
		// Push well past the window and confirm no late-fired write.
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 100);
		const writes = adapter.ops.filter((o) => o.kind === 'write');
		expect(writes).toHaveLength(0);
	});

	it('cancel() then save() does NOT replay the cancelled snapshot — only the new save lands', async () => {
		const adapter = new MemoryAdapter();
		const save = debouncedSaver(adapter);
		// First snapshot — content matters because we assert which one
		// lands on disk.
		save('abc', sampleSnapshot('abc'));
		save.cancel();
		// Now save a DIFFERENT snapshot. The cancelled one must not
		// replay through any leftover timer / pending queue.
		const fresh: SessionSnapshot = { ...sampleSnapshot('abc'), updatedAt: 7777 };
		save('abc', fresh);
		await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 100);
		const writes = adapter.ops.filter((o) => o.kind === 'write');
		expect(writes).toHaveLength(1);
		const finalPath = sessionFilePath('abc');
		const text = adapter.files.get(finalPath);
		expect(text).toBeDefined();
		expect(JSON.parse(text!).updatedAt).toBe(7777);
	});
});
