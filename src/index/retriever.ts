import { TFile, normalizePath, type CachedMetadata } from 'obsidian';
import type YunseulPlugin from '../main';
import { BM25Index, type DocFields } from './bm25';
import { makeNonce } from '../util/guards';

// VaultRetriever — Obsidian-aware glue between BM25Index and the live
// vault. The pure BM25Index has no idea what a TFile is; this layer
// owns the file-to-doc mapping, the on-disk persistence path, and the
// incremental-update API the change listeners in main.ts call into.
//
// Persistence path: `<vault>/.yunseul/bm25-index.json`. Per the plan,
// this lives outside `.obsidian/` so it survives plugin reinstall and
// users can add it to Syncthing/iCloud ignore lists. Reads/writes go
// through vault.adapter because the directory is hidden from the Vault
// API (which only enumerates files in the markdown surface).
//
// Atomic write: write `.tmp` sibling, then rename. Same shape as the
// session persistence code in chat/persist.ts.

export interface RetrievalResult {
	file: TFile;
	score: number;
	matchedTerms: string[];
}

export interface SearchOptions {
	topK: number;
	excludeTags: string[];
	excludePaths: string[];
}

interface BuildOptions {
	onProgress?: (done: number, total: number) => void;
	signal?: AbortSignal;
}

// Per-file body cap to keep a single multi-MB file from poisoning peak
// memory at index time. 200 KB is enough to cover ~50 pages of prose;
// longer files are truncated for indexing purposes only (the on-disk
// file is untouched).
const PER_FILE_BODY_MAX_CHARS = 200_000;

// Yield to the event loop every YIELD_EVERY documents during a full
// build. 25 is conservative — a 7B chat model on the same machine wants
// CPU, and we don't want a build to pin the renderer for seconds at a
// time on a 5000-note vault. Tunable if benchmarks suggest different.
const YIELD_EVERY = 25;


export class VaultRetriever {
	private readonly plugin: YunseulPlugin;
	private readonly indexPath: string;
	private bm25: BM25Index;
	// Tracks whether we have at least one valid in-memory index. Search
	// against an empty index returns [] anyway, but we may want to gate
	// auto-rebuild behavior on this in the future.
	private ready = false;
	// Tracks an in-flight save promise so the caller (debounced reindex)
	// can chain rather than racing two writers on the same path.
	private savePromise: Promise<void> | null = null;

	constructor(plugin: YunseulPlugin, indexPath: string) {
		this.plugin = plugin;
		this.indexPath = normalizePath(indexPath);
		this.bm25 = new BM25Index();
	}

	size(): number {
		return this.bm25.size();
	}

	isReady(): boolean {
		return this.ready;
	}

	/**
	 * Rebuild the index by enumerating every markdown file in the vault.
	 * Reads frontmatter / headings / tags via metadataCache (cheap, in
	 * memory) and the body via vault.cachedRead (mostly cheap, may hit
	 * disk on cold cache). Yields to the event loop every YIELD_EVERY
	 * documents so the renderer stays interactive on a 5000-note vault.
	 *
	 * Respects `opts.signal` — when aborted (e.g. plugin disable or user
	 * cancel) throws a DOMException('AbortError') so the caller can
	 * swallow it cleanly. Cancellation is checked at the top of every
	 * iteration AND at each YIELD_EVERY yield point so a 20-minute build
	 * can be cut short within a few hundred milliseconds.
	 */
	async buildFromVault(opts?: BuildOptions): Promise<void> {
		const signal = opts?.signal;
		const checkAborted = (): void => {
			if (signal?.aborted === true) {
				throw new DOMException('Vault index build aborted', 'AbortError');
			}
		};
		const files = this.plugin.app.vault.getMarkdownFiles();
		const total = files.length;
		// Reset to a fresh index so a rebuild after a previous build
		// doesn't double-count anything.
		this.bm25 = new BM25Index();
		let done = 0;
		for (const file of files) {
			checkAborted();
			try {
				const fields = await this.fieldsForFile(file);
				this.bm25.add(file.path, fields);
			} catch (e) {
				// Don't bring down the whole build on a single corrupt file
				// or transient read error — log and continue. The next
				// metadataCache.changed event will retry that file.
				this.plugin.logger.warn(
					`Index build: skipped ${file.path} — ${e instanceof Error ? e.message : String(e)}`,
				);
			}
			done += 1;
			if (opts?.onProgress !== undefined) opts.onProgress(done, total);
			if (done % YIELD_EVERY === 0) {
				await new Promise((r) => window.setTimeout(r, 0));
				checkAborted();
			}
		}
		this.ready = true;
	}

	/**
	 * Load a previously-saved index from disk. Returns true on success,
	 * false on any non-fatal failure (missing file, schema mismatch,
	 * parse error). False signals to the caller that they should rebuild.
	 */
	async load(): Promise<boolean> {
		const adapter = this.plugin.app.vault.adapter;
		try {
			if (!(await adapter.exists(this.indexPath))) return false;
			const text = await adapter.read(this.indexPath);
			let parsed: unknown;
			try {
				parsed = JSON.parse(text);
			} catch {
				return false;
			}
			if (!isPlainObject(parsed)) return false;
			const r = parsed;
			if (r.schemaVersion !== 1) return false;
			const inner = r.index;
			if (!isPlainObject(inner)) return false;
			try {
				this.bm25 = BM25Index.fromJSON(inner);
			} catch {
				return false;
			}
			this.ready = true;
			return true;
		} catch (e) {
			this.plugin.logger.warn(
				`Index load failed: ${e instanceof Error ? e.message : String(e)}`,
			);
			return false;
		}
	}

	/**
	 * Persist the index atomically. Serializes concurrent callers via a
	 * single chained in-flight promise so a burst of save() calls always
	 * collapses to at most one *active* writer plus at most one queued
	 * follow-up; the snapshot for the queued write is taken inside the
	 * chained .then() so it captures the latest in-memory state.
	 * We don't debounce here — the caller (main.ts) wires a debounced
	 * reindex pipeline that calls save() at most every 1500ms anyway.
	 */
	async save(): Promise<void> {
		// Always queue the next save behind any pending chain. Capturing
		// the snapshot inside the .then() means the later save sees the
		// latest BM25 state, not whatever was current at queue time.
		const previous = this.savePromise ?? Promise.resolve();
		const next = previous
			.catch(() => {
				// Swallow — the next save attempt is independent.
			})
			.then(() => this.doSave());
		this.savePromise = next;
		try {
			await next;
		} finally {
			// Only clear the slot if no newer chain has been queued behind
			// us. If another save() landed while we were running, leave
			// the slot pointing at its (newer) chain.
			if (this.savePromise === next) this.savePromise = null;
		}
	}

	private async doSave(): Promise<void> {
		const adapter = this.plugin.app.vault.adapter;
		const dir = this.indexPath.slice(0, this.indexPath.lastIndexOf('/'));
		if (dir.length > 0 && !(await adapter.exists(dir))) {
			await adapter.mkdir(dir);
		}
		// Snapshot the index inside doSave so the chained save() above
		// sees the latest state when it actually runs.
		const payload = {
			schemaVersion: 1,
			builtAt: Date.now(),
			docs: this.bm25.size(),
			index: this.bm25.toJSON(),
		};
		const serialized = JSON.stringify(payload);
		const tmp = `${this.indexPath}.${makeNonce()}.tmp`;
		await adapter.write(tmp, serialized);
		try {
			await adapter.rename(tmp, this.indexPath);
		} catch {
			// Fallback: some adapters refuse rename-over-existing.
			try {
				if (await adapter.exists(this.indexPath)) {
					await adapter.remove(this.indexPath);
				}
				await adapter.rename(tmp, this.indexPath);
			} catch (e) {
				// Best-effort cleanup of the orphan tmp so failed saves
				// don't accumulate on disk across launches.
				try {
					if (await adapter.exists(tmp)) await adapter.remove(tmp);
				} catch {
					// Nothing more we can do here.
				}
				throw e;
			}
		}
	}

	async reindexFile(file: TFile): Promise<void> {
		// Filter to markdown by extension — non-md files reach this path
		// when the vault.on('create') listener is wired without a guard.
		// (We do guard in main.ts but defense-in-depth.)
		if (file.extension !== 'md') return;
		try {
			const fields = await this.fieldsForFile(file);
			this.bm25.replace(file.path, fields);
			this.ready = true;
		} catch (e) {
			this.plugin.logger.warn(
				`Reindex failed for ${file.path}: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
	}

	removeFile(path: string): void {
		this.bm25.remove(path);
	}

	search(query: string, opts: SearchOptions): RetrievalResult[] {
		// Over-fetch by a small factor so the post-filter for excluded
		// tags/paths still has enough candidates to fill topK. 4× is
		// arbitrary but matches what most lexical retrievers do when
		// they need to support filters at the result layer.
		const rawTopK = Math.max(opts.topK * 4, opts.topK);
		const hits = this.bm25.search(query, rawTopK);
		const excludedTags = new Set(
			opts.excludeTags.map((t) => normalizeTagForExclusion(t)).filter((t) => t.length > 0),
		);
		const excludedPaths = new Set(opts.excludePaths);

		const out: RetrievalResult[] = [];
		for (const h of hits) {
			if (excludedPaths.has(h.docId)) continue;
			const af = this.plugin.app.vault.getAbstractFileByPath(h.docId);
			if (!(af instanceof TFile)) continue;
			if (excludedTags.size > 0 && this.fileHasAnyTag(af, excludedTags)) continue;
			out.push({ file: af, score: h.score, matchedTerms: h.matchedTerms });
			if (out.length >= opts.topK) break;
		}
		return out;
	}

	// ---- Internals ----------------------------------------------------

	private async fieldsForFile(file: TFile): Promise<DocFields> {
		const cache = this.plugin.app.metadataCache.getFileCache(file);
		const title = file.basename;
		const heading = firstHeading(cache);
		const tags = collectTags(cache);
		const rawBody = await this.plugin.app.vault.cachedRead(file);
		// Cap per-file body for indexing. A single multi-MB note is a
		// rare-but-real failure mode (a giant clipped page, an inlined
		// log dump) and unbounded body length blows up peak memory at
		// build time. Truncation only affects the index — the file on
		// disk is untouched and the chat layer reads the full content
		// independently when injecting a retrieved chunk.
		const body = rawBody.length > PER_FILE_BODY_MAX_CHARS
			? rawBody.slice(0, PER_FILE_BODY_MAX_CHARS)
			: rawBody;
		return { title, heading, tags, body };
	}

	private fileHasAnyTag(file: TFile, excludedTags: Set<string>): boolean {
		const cache = this.plugin.app.metadataCache.getFileCache(file);
		if (cache === null) return false;
		for (const tag of collectTags(cache)) {
			if (excludedTags.has(normalizeTagForExclusion(tag))) return true;
		}
		return false;
	}
}

function firstHeading(cache: CachedMetadata | null): string {
	if (cache === null) return '';
	const headings = cache.headings;
	if (headings === undefined || headings.length === 0) return '';
	return headings[0]?.heading ?? '';
}

function collectTags(cache: CachedMetadata | null): string[] {
	if (cache === null) return [];
	const out: string[] = [];
	// Inline `#tag` references found in body.
	if (cache.tags !== undefined) {
		for (const t of cache.tags) out.push(t.tag);
	}
	// Frontmatter `tags:` field. Obsidian normalizes a few shapes (string,
	// array of strings, nested with #). We accept all three so the
	// retriever sees what the user wrote.
	const fm = cache.frontmatter;
	if (fm !== undefined && fm !== null) {
		const raw: unknown = (fm as Record<string, unknown>).tags;
		if (typeof raw === 'string') {
			for (const t of raw.split(/[,\s]+/)) {
				if (t.length > 0) out.push(t);
			}
		} else if (Array.isArray(raw)) {
			for (const t of raw) {
				if (typeof t === 'string') out.push(t);
			}
		}
	}
	return out;
}

function normalizeTagForExclusion(tag: string): string {
	// Strip leading `#` so user-entered `#javascript` matches indexed
	// `javascript` (and vice versa). Lowercase for case-insensitive match.
	return tag.replace(/^#+/, '').trim().toLocaleLowerCase();
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
	return typeof x === 'object' && x !== null && !Array.isArray(x);
}

