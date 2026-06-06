import { describe, expect, it } from 'vitest';
import { TFile, type CachedMetadata } from 'obsidian';
import { VaultRetriever } from '../src/index/retriever';
import type YunseulPlugin from '../src/main';

// VaultRetriever owns the on-disk BM25 index (atomic write-rename), the
// metadataCache-driven full build, and the post-filter exclude rules.
// We drive it with a MemoryAdapter (file-system surrogate) and a stub
// plugin that exposes only the surface the retriever reads from. The
// MemoryAdapter tracks operation order so we can assert "write .tmp,
// then rename" without depending on real fs semantics.

// ---- Minimal stub plugin --------------------------------------------

interface FakeFile {
	path: string;
	basename: string;
	extension: string;
	content: string;
	cache: CachedMetadata | null;
}

interface Op {
	kind: string;
	path: string;
	secondPath?: string;
}

class MemoryAdapter {
	files = new Map<string, string>();
	ops: Op[] = [];
	failNextRename = false;

	async exists(p: string): Promise<boolean> {
		this.ops.push({ kind: 'exists', path: p });
		if (this.files.has(p)) return true;
		for (const k of this.files.keys()) {
			if (k.startsWith(`${p}/`)) return true;
		}
		return false;
	}

	async read(p: string): Promise<string> {
		const v = this.files.get(p);
		if (v === undefined) {
			const err: NodeJS.ErrnoException = Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
			throw err;
		}
		return v;
	}

	async write(p: string, d: string): Promise<void> {
		this.ops.push({ kind: 'write', path: p });
		this.files.set(p, d);
	}

	async rename(from: string, to: string): Promise<void> {
		this.ops.push({ kind: 'rename', path: from, secondPath: to });
		if (this.failNextRename) {
			this.failNextRename = false;
			throw new Error('simulated rename failure');
		}
		const v = this.files.get(from);
		if (v === undefined) throw new Error(`rename: source missing ${from}`);
		this.files.set(to, v);
		this.files.delete(from);
	}

	async mkdir(p: string): Promise<void> {
		this.ops.push({ kind: 'mkdir', path: p });
	}

	async remove(p: string): Promise<void> {
		this.ops.push({ kind: 'remove', path: p });
		this.files.delete(p);
	}
}

interface StubPlugin {
	app: {
		vault: {
			adapter: MemoryAdapter;
			getMarkdownFiles: () => TFile[];
			cachedRead: (file: TFile) => Promise<string>;
			getAbstractFileByPath: (p: string) => TFile | null;
		};
		metadataCache: {
			getFileCache: (file: TFile) => CachedMetadata | null;
		};
	};
	logger: {
		debug: (...a: unknown[]) => void;
		info: (...a: unknown[]) => void;
		warn: (...a: unknown[]) => void;
		error: (...a: unknown[]) => void;
	};
}

function makeStubPlugin(fakeFiles: FakeFile[], adapter?: MemoryAdapter): StubPlugin {
	const a = adapter ?? new MemoryAdapter();
	const byPath = new Map<string, FakeFile>();
	const tfiles: TFile[] = [];
	for (const f of fakeFiles) {
		byPath.set(f.path, f);
		const tf = new TFile();
		tf.path = f.path;
		tf.basename = f.basename;
		tf.extension = f.extension;
		tf.name = `${f.basename}.${f.extension}`;
		(tf as unknown as { __content: string }).__content = f.content;
		tfiles.push(tf);
	}
	return {
		app: {
			vault: {
				adapter: a,
				getMarkdownFiles: (): TFile[] => tfiles,
				cachedRead: async (file: TFile): Promise<string> => {
					return byPath.get(file.path)?.content ?? '';
				},
				getAbstractFileByPath: (p: string): TFile | null => {
					return tfiles.find((t) => t.path === p) ?? null;
				},
			},
			metadataCache: {
				getFileCache: (file: TFile): CachedMetadata | null => {
					return byPath.get(file.path)?.cache ?? null;
				},
			},
		},
		logger: {
			debug: (): void => {},
			info: (): void => {},
			warn: (): void => {},
			error: (): void => {},
		},
	};
}

function cast(plugin: StubPlugin): YunseulPlugin {
	return plugin as unknown as YunseulPlugin;
}

function cacheWithTagsAndHeading(tags: string[], heading?: string): CachedMetadata {
	return {
		tags: tags.map((t) => ({
			tag: t,
			position: { start: { offset: 0 }, end: { offset: 0 } },
		})),
		headings: heading === undefined ? [] : [
			{
				heading,
				level: 1,
				position: { start: { offset: 0 }, end: { offset: 0 } },
			},
		],
	};
}

// ---- Tests -----------------------------------------------------------

describe('VaultRetriever — buildFromVault + save round-trip', () => {
	it('persists the built index and a fresh retriever reads back the same top-K', async () => {
		const files: FakeFile[] = [
			{
				path: 'notes/rust.md',
				basename: 'rust',
				extension: 'md',
				content: 'Rust async tokio runtime patterns and pitfalls.',
				cache: cacheWithTagsAndHeading(['#programming'], 'Rust'),
			},
			{
				path: 'notes/python.md',
				basename: 'python',
				extension: 'md',
				content: 'Python asyncio coroutines and event loops.',
				cache: cacheWithTagsAndHeading(['#programming'], 'Python'),
			},
			{
				path: 'recipes/pasta.md',
				basename: 'pasta',
				extension: 'md',
				content: 'Carbonara recipe with guanciale and pecorino.',
				cache: cacheWithTagsAndHeading(['#cooking'], 'Pasta'),
			},
		];
		const adapter = new MemoryAdapter();
		const plugin = makeStubPlugin(files, adapter);
		const indexPath = '.yunseul/bm25-index.json';

		const original = new VaultRetriever(cast(plugin), indexPath);
		await original.buildFromVault();
		await original.save();

		// New retriever instance — load from disk and verify search returns
		// the same top-K as the freshly-built original for the same query.
		const fresh = new VaultRetriever(cast(plugin), indexPath);
		const loaded = await fresh.load();
		expect(loaded).toBe(true);

		const q = 'rust async';
		const a = original.search(q, { topK: 2, excludeTags: [], excludePaths: [] });
		const b = fresh.search(q, { topK: 2, excludeTags: [], excludePaths: [] });
		expect(a.length).toBeGreaterThan(0);
		expect(b.map((h) => h.file.path)).toEqual(a.map((h) => h.file.path));
	});
});

describe('VaultRetriever — atomic save', () => {
	it('writes the .tmp sibling BEFORE renaming to the final index path', async () => {
		const adapter = new MemoryAdapter();
		const plugin = makeStubPlugin([], adapter);
		const indexPath = '.yunseul/bm25-index.json';
		const retriever = new VaultRetriever(cast(plugin), indexPath);
		await retriever.buildFromVault();
		await retriever.save();

		const writeIdx = adapter.ops.findIndex(
			(o) => o.kind === 'write' && o.path.endsWith('.tmp'),
		);
		const renameIdx = adapter.ops.findIndex(
			(o) => o.kind === 'rename' && o.secondPath === indexPath,
		);
		expect(writeIdx).toBeGreaterThan(-1);
		expect(renameIdx).toBeGreaterThan(writeIdx);
	});

	it('cleans up the orphan .tmp file when the final rename fails', async () => {
		const adapter = new MemoryAdapter();
		const plugin = makeStubPlugin([], adapter);
		const indexPath = '.yunseul/bm25-index.json';
		const retriever = new VaultRetriever(cast(plugin), indexPath);
		await retriever.buildFromVault();

		// Inject: every rename throws. The fallback (remove + retry rename)
		// will also fail because the second rename source is still .tmp and
		// nothing else to overwrite — the retriever should remove the tmp.
		const origRename = adapter.rename.bind(adapter);
		adapter.rename = async (from: string, to: string): Promise<void> => {
			adapter.ops.push({ kind: 'rename-fail', path: from, secondPath: to });
			throw new Error('simulated rename always fails');
		};

		await expect(retriever.save()).rejects.toThrow();
		// Restore for safety even though the test ends here.
		adapter.rename = origRename;
		// Confirm a remove() of the tmp ran as part of the cleanup.
		const tmpRemove = adapter.ops.find(
			(o) => o.kind === 'remove' && o.path.endsWith('.tmp'),
		);
		expect(tmpRemove).toBeDefined();
	});
});

describe('VaultRetriever — buildFromVault abort', () => {
	it('throws AbortError when the signal aborts before the loop starts', async () => {
		const files: FakeFile[] = [
			{
				path: 'a.md',
				basename: 'a',
				extension: 'md',
				content: 'alpha',
				cache: null,
			},
			{
				path: 'b.md',
				basename: 'b',
				extension: 'md',
				content: 'beta',
				cache: null,
			},
		];
		const plugin = makeStubPlugin(files);
		const retriever = new VaultRetriever(cast(plugin), '.yunseul/bm25-index.json');
		const ctrl = new AbortController();
		ctrl.abort();
		await expect(retriever.buildFromVault({ signal: ctrl.signal })).rejects.toMatchObject({
			name: 'AbortError',
		});
		// The in-memory index is partially-populated (reset to empty on
		// build entry, then aborted before adds). The caller is responsible
		// for rolling back from disk; we only assert size() returns a
		// number so the property is observable.
		expect(retriever.size()).toBe(0);
	});
});

describe('VaultRetriever.search filters', () => {
	const files: FakeFile[] = [
		{
			path: 'work/notes.md',
			basename: 'notes',
			extension: 'md',
			content: 'planning meeting agenda for the team',
			cache: cacheWithTagsAndHeading(['#work'], 'Work'),
		},
		{
			path: 'journal/today.md',
			basename: 'today',
			extension: 'md',
			content: 'planning my personal goals and journal entries',
			cache: cacheWithTagsAndHeading(['#personal'], 'Personal'),
		},
	];

	it('excludeTags filters out documents whose tags overlap', async () => {
		const plugin = makeStubPlugin(files);
		const retriever = new VaultRetriever(cast(plugin), '.yunseul/bm25-index.json');
		await retriever.buildFromVault();

		const out = retriever.search('planning', {
			topK: 5,
			excludeTags: ['personal'],
			excludePaths: [],
		});
		expect(out.length).toBeGreaterThan(0);
		for (const hit of out) {
			expect(hit.file.path).not.toBe('journal/today.md');
		}
	});

	it('excludePaths filters out documents whose docId is in the set', async () => {
		const plugin = makeStubPlugin(files);
		const retriever = new VaultRetriever(cast(plugin), '.yunseul/bm25-index.json');
		await retriever.buildFromVault();

		const out = retriever.search('planning', {
			topK: 5,
			excludeTags: [],
			excludePaths: ['journal/today.md'],
		});
		for (const hit of out) {
			expect(hit.file.path).not.toBe('journal/today.md');
		}
	});
});

describe('VaultRetriever.load schema/corruption guards', () => {
	it('returns false (and leaves the index unchanged) on schemaVersion mismatch', async () => {
		const adapter = new MemoryAdapter();
		const plugin = makeStubPlugin([], adapter);
		const indexPath = '.yunseul/bm25-index.json';
		adapter.files.set(
			indexPath,
			JSON.stringify({
				schemaVersion: 0,
				builtAt: 0,
				docs: 0,
				index: { schemaVersion: 0 },
			}),
		);
		const retriever = new VaultRetriever(cast(plugin), indexPath);
		const ok = await retriever.load();
		expect(ok).toBe(false);
		expect(retriever.isReady()).toBe(false);
		expect(retriever.size()).toBe(0);
	});

	it('returns false on corrupt JSON without throwing', async () => {
		const adapter = new MemoryAdapter();
		const plugin = makeStubPlugin([], adapter);
		const indexPath = '.yunseul/bm25-index.json';
		adapter.files.set(indexPath, 'not valid json {{{');
		const retriever = new VaultRetriever(cast(plugin), indexPath);
		const ok = await retriever.load();
		expect(ok).toBe(false);
		expect(retriever.isReady()).toBe(false);
	});
});
