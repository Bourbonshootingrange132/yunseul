// BM25 inverted index — pure module (no Obsidian deps) so it is fully
// vitest-testable. The retriever layer in retriever.ts is the only
// place that knows about TFile / vault.adapter / metadataCache. We
// implement standard Okapi BM25 with k1=1.5 and b=0.75 per field,
// with field boosts (title × 3, heading × 2, tags × 2, body × 1) and
// per-field length normalization. Field boosts apply at scoring time
// so a single term observed in multiple fields contributes additively.
//
// Storage shape:
//   inverted: Map<term, Map<docId, Posting>>
//   doc[id]  = { lens: { title, heading, tags, body }, total }
// where Posting holds the per-field term frequencies.
//
// We track per-field term frequency rather than computing a flattened
// weighted tf at index time because (a) it keeps the index portable
// across boost-tuning changes (boosts live with the scorer, not the
// data), (b) per-field length normalization needs the per-field tf
// anyway. The memory cost is a 4-int Posting instead of a 1-int int.

export type Field = 'title' | 'heading' | 'tags' | 'body';

export interface DocFields {
	title: string;
	heading: string;
	tags: string[];
	body: string;
}

export interface SearchHit {
	docId: string;
	score: number;
	matchedTerms: string[];
}

interface Posting {
	// Per-field raw term frequency within the document for one term.
	title: number;
	heading: number;
	tags: number;
	body: number;
}

interface DocStats {
	// Per-field token count (token count, not char count) used in BM25
	// length normalization. We persist these in toJSON() so a loaded
	// index can re-score without re-tokenizing.
	lens: { title: number; heading: number; tags: number; body: number };
}

// Inline English stop-word list. Tiny on purpose — the larger the list,
// the more "real" queries we accidentally murder. The token "in" alone
// kills queries like "in-memory storage", which is why we keep it
// minimal and don't pull a big NLP stop-word set.
const STOP_WORDS = new Set<string>([
	'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'of', 'to',
	'in', 'on', 'at', 'for', 'with', 'as', 'is', 'are', 'was', 'were',
	'be', 'been', 'it', 'this', 'that', 'these', 'those', 'i', 'you',
	'he', 'she', 'they', 'we', 'my', 'your', 'their', 'our',
]);

// Unicode-aware word boundary. \p{L} matches any letter, \p{N} matches
// any digit. This keeps CJK, Cyrillic, Arabic etc. as single tokens
// rather than splitting on every char as ASCII \w+ would.
const WORD_BOUNDARY_RE = /[^\p{L}\p{N}]+/u;

const MIN_TOKEN_LEN = 2;

// BM25 parameters. Standard k1=1.5 and b=0.75 per field. We use a single
// k1 across fields — varying k1 per field is a tuning knob we'd rather
// expose via field boosts than via per-field k1 maths.
const K1 = 1.5;
const B = 0.75;

// Field boosts applied to per-field BM25 contributions. These must be
// non-negative; the title boost dominates the scoring (a term in the
// title is "worth" three times the same term in the body).
const FIELD_BOOST: Record<Field, number> = {
	title: 3,
	heading: 2,
	tags: 2,
	body: 1,
};

const SCHEMA_VERSION = 1;

// ---- Tokenizer (exported for tests) ----------------------------------

/**
 * Tokenize a string into normalized BM25 tokens.
 *
 * Pipeline:
 *  1. Lowercase (Unicode-aware via toLocaleLowerCase()).
 *  2. Split on `/[^\p{L}\p{N}]+/u` so any non-letter/number byte breaks
 *     the token. Apostrophes and hyphens are NOT preserved — `don't`
 *     becomes `don` `t` (the `t` is then dropped by min-length).
 *  3. Drop tokens shorter than `MIN_TOKEN_LEN` (2). Single-char tokens
 *     are universally junk for BM25 (acronyms aside) and dropping them
 *     keeps the inverted index small.
 *  4. Drop stop words from the inline English list. Stop-words are
 *     dropped after lowercasing so `THE` matches as well.
 *
 * Pure function. Exported so tests can probe the tokenizer in
 * isolation without going through the index.
 */
export function tokenize(s: string): string[] {
	if (s.length === 0) return [];
	const lowered = s.toLocaleLowerCase();
	const raw = lowered.split(WORD_BOUNDARY_RE);
	const out: string[] = [];
	for (const t of raw) {
		if (t.length < MIN_TOKEN_LEN) continue;
		if (STOP_WORDS.has(t)) continue;
		out.push(t);
	}
	return out;
}

// ---- BM25Index --------------------------------------------------------

export class BM25Index {
	// inverted[term].get(docId) → Posting (per-field tfs)
	private inverted: Map<string, Map<string, Posting>> = new Map();
	// docId → per-field token counts (for BM25 length normalization)
	private docs: Map<string, DocStats> = new Map();
	// Running sum of per-field token counts. Divided by docs.size at
	// scoring time to get avg doc length per field. Kept as a running
	// total so add/remove are O(1) for the stats update.
	private sumLen: { title: number; heading: number; tags: number; body: number } = {
		title: 0,
		heading: 0,
		tags: 0,
		body: 0,
	};

	size(): number {
		return this.docs.size;
	}

	add(docId: string, fields: DocFields): void {
		if (this.docs.has(docId)) {
			// Caller violated the contract; idempotent behavior is the
			// least surprising response. Treat add() as replace() when
			// the doc already exists.
			this.remove(docId);
		}
		// Tokenize each field independently. Tags are already a list,
		// so we tokenize each tag string and concatenate; this handles
		// multi-word tag names like `#machine-learning` deterministically.
		const titleToks = tokenize(fields.title);
		const headingToks = tokenize(fields.heading);
		const tagToks: string[] = [];
		for (const t of fields.tags) {
			for (const tok of tokenize(t)) tagToks.push(tok);
		}
		const bodyToks = tokenize(fields.body);

		const lens = {
			title: titleToks.length,
			heading: headingToks.length,
			tags: tagToks.length,
			body: bodyToks.length,
		};
		this.docs.set(docId, { lens });
		this.sumLen.title += lens.title;
		this.sumLen.heading += lens.heading;
		this.sumLen.tags += lens.tags;
		this.sumLen.body += lens.body;

		// Accumulate per-term, per-field tfs into a temp map then commit
		// to the inverted index. Building locally first avoids touching
		// the inverted map for every token (one upsert per unique term).
		const local = new Map<string, Posting>();
		const upsert = (tok: string, field: Field): void => {
			let p = local.get(tok);
			if (p === undefined) {
				p = { title: 0, heading: 0, tags: 0, body: 0 };
				local.set(tok, p);
			}
			p[field] += 1;
		};
		for (const t of titleToks) upsert(t, 'title');
		for (const t of headingToks) upsert(t, 'heading');
		for (const t of tagToks) upsert(t, 'tags');
		for (const t of bodyToks) upsert(t, 'body');

		for (const [term, posting] of local) {
			let row = this.inverted.get(term);
			if (row === undefined) {
				row = new Map();
				this.inverted.set(term, row);
			}
			row.set(docId, posting);
		}
	}

	remove(docId: string): void {
		const stats = this.docs.get(docId);
		if (stats === undefined) return;
		this.sumLen.title -= stats.lens.title;
		this.sumLen.heading -= stats.lens.heading;
		this.sumLen.tags -= stats.lens.tags;
		this.sumLen.body -= stats.lens.body;
		this.docs.delete(docId);
		// Sweep the inverted index, dropping this doc from every term's
		// postings. We accept the O(unique-terms) cost because incremental
		// reindex is rare relative to search. Terms with empty postings
		// after deletion are removed so the index doesn't grow stale
		// keys forever.
		const emptyTerms: string[] = [];
		for (const [term, postings] of this.inverted) {
			if (postings.delete(docId) && postings.size === 0) {
				emptyTerms.push(term);
			}
		}
		for (const t of emptyTerms) this.inverted.delete(t);
	}

	replace(docId: string, fields: DocFields): void {
		// remove() is idempotent on a missing id so this is safe even
		// for first-time inserts. We chose `replace` to be the documented
		// upsert path; the difference vs add() is purely semantic.
		this.remove(docId);
		this.add(docId, fields);
	}

	search(query: string, topK: number): SearchHit[] {
		if (topK <= 0) return [];
		const queryTerms = tokenize(query);
		if (queryTerms.length === 0) return [];

		// Dedup query terms — multiple occurrences in the query should
		// not multi-count idf. (BM25 query weighting is typically tf=1
		// per term per query anyway.)
		const uniq = Array.from(new Set(queryTerms));

		const N = this.docs.size;
		if (N === 0) return [];

		// Precompute averages once per query.
		const avg = {
			title: N === 0 ? 0 : this.sumLen.title / N,
			heading: N === 0 ? 0 : this.sumLen.heading / N,
			tags: N === 0 ? 0 : this.sumLen.tags / N,
			body: N === 0 ? 0 : this.sumLen.body / N,
		};

		// Accumulator keyed by docId. Stores the running score and the
		// distinct matched terms — distinct so the UI surface ("matched:
		// rust, async") doesn't repeat the same term per field hit.
		const scores = new Map<string, { score: number; matched: Set<string> }>();

		for (const term of uniq) {
			const postings = this.inverted.get(term);
			if (postings === undefined) continue;
			const df = postings.size;
			// BM25 IDF with the +0.5/-0.5 smoothing. The `+1` inside the
			// log keeps idf non-negative for terms appearing in over half
			// the corpus (a real-world thing for short corpora).
			const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));

			for (const [docId, posting] of postings) {
				const stats = this.docs.get(docId);
				if (stats === undefined) continue;
				let contribution = 0;
				// Sum per-field BM25 contributions weighted by field boost.
				// A term appearing in both title and body of the same doc
				// gets both contributions; that's the intent — title hits
				// are not exclusive.
				const fields: Field[] = ['title', 'heading', 'tags', 'body'];
				for (const f of fields) {
					const tf = posting[f];
					if (tf === 0) continue;
					const len = stats.lens[f];
					const avgLen = avg[f];
					// Guard against divide-by-zero: if avgLen is 0 then no
					// doc has any tokens in this field, but we still got
					// here because this doc somehow has tf>0 — defensive,
					// shouldn't normally happen.
					const denomLen = avgLen === 0 ? 1 : avgLen;
					const norm = 1 - B + B * (len / denomLen);
					const bm25 = (tf * (K1 + 1)) / (tf + K1 * norm);
					contribution += FIELD_BOOST[f] * idf * bm25;
				}
				if (contribution === 0) continue;
				let acc = scores.get(docId);
				if (acc === undefined) {
					acc = { score: 0, matched: new Set() };
					scores.set(docId, acc);
				}
				acc.score += contribution;
				acc.matched.add(term);
			}
		}

		// Sort descending by score, then by docId asc so the result order
		// is fully deterministic when two hits tie. Slice to topK at the
		// end so we don't allocate intermediate arrays per K.
		const hits: SearchHit[] = [];
		for (const [docId, acc] of scores) {
			hits.push({ docId, score: acc.score, matchedTerms: Array.from(acc.matched) });
		}
		hits.sort((a, b) => {
			if (b.score !== a.score) return b.score - a.score;
			if (a.docId < b.docId) return -1;
			if (a.docId > b.docId) return 1;
			return 0;
		});
		return hits.slice(0, topK);
	}

	// ---- Serialization -------------------------------------------------

	toJSON(): object {
		// We serialize the inverted index as a flat array of
		// [term, [[docId, postingTuple], ...]] entries because Map is not
		// JSON-native. Postings are stored as 4-element tuples
		// [title, heading, tags, body] to save bytes vs the {} form on a
		// large index.
		const invertedOut: Array<[string, Array<[string, [number, number, number, number]]>]> = [];
		for (const [term, postings] of this.inverted) {
			const arr: Array<[string, [number, number, number, number]]> = [];
			for (const [docId, p] of postings) {
				arr.push([docId, [p.title, p.heading, p.tags, p.body]]);
			}
			invertedOut.push([term, arr]);
		}
		const docsOut: Array<[string, [number, number, number, number]]> = [];
		for (const [docId, stats] of this.docs) {
			docsOut.push([docId, [stats.lens.title, stats.lens.heading, stats.lens.tags, stats.lens.body]]);
		}
		return {
			schemaVersion: SCHEMA_VERSION,
			builtAt: Date.now(),
			docs: this.docs.size,
			inverted: invertedOut,
			docStats: docsOut,
			sumLen: this.sumLen,
		};
	}

	static fromJSON(data: unknown): BM25Index {
		if (!isPlainObject(data)) throw new Error('BM25Index.fromJSON: not an object');
		const r = data;
		if (r.schemaVersion !== SCHEMA_VERSION) {
			throw new Error(
				`BM25Index.fromJSON: schema version mismatch (got ${String(r.schemaVersion)}, expected ${SCHEMA_VERSION})`,
			);
		}
		const inverted = r.inverted;
		const docStats = r.docStats;
		const sumLen = r.sumLen;
		if (!Array.isArray(inverted)) throw new Error('BM25Index.fromJSON: inverted missing');
		if (!Array.isArray(docStats)) throw new Error('BM25Index.fromJSON: docStats missing');
		if (!isPlainObject(sumLen)) throw new Error('BM25Index.fromJSON: sumLen missing');

		const idx = new BM25Index();
		// Restore doc stats first so add() consistency checks (if any are
		// added later) can see the lens table.
		for (const entry of docStats) {
			if (!Array.isArray(entry) || entry.length !== 2) continue;
			const [docId, lensArr] = entry as [unknown, unknown];
			if (typeof docId !== 'string') continue;
			if (!Array.isArray(lensArr) || lensArr.length !== 4) continue;
			const [tl, hl, gl, bl] = lensArr as [unknown, unknown, unknown, unknown];
			if (
				typeof tl !== 'number' || typeof hl !== 'number' ||
				typeof gl !== 'number' || typeof bl !== 'number'
			) continue;
			idx.docs.set(docId, { lens: { title: tl, heading: hl, tags: gl, body: bl } });
		}
		for (const entry of inverted) {
			if (!Array.isArray(entry) || entry.length !== 2) continue;
			const [term, postings] = entry as [unknown, unknown];
			if (typeof term !== 'string') continue;
			if (!Array.isArray(postings)) continue;
			const row = new Map<string, Posting>();
			for (const p of postings) {
				if (!Array.isArray(p) || p.length !== 2) continue;
				const [docId, tup] = p as [unknown, unknown];
				if (typeof docId !== 'string') continue;
				if (!Array.isArray(tup) || tup.length !== 4) continue;
				const [a, b, c, d] = tup as [unknown, unknown, unknown, unknown];
				if (typeof a !== 'number' || typeof b !== 'number' || typeof c !== 'number' || typeof d !== 'number') continue;
				row.set(docId, { title: a, heading: b, tags: c, body: d });
			}
			if (row.size > 0) idx.inverted.set(term, row);
		}
		const sl = sumLen;
		if (
			typeof sl.title === 'number' && typeof sl.heading === 'number' &&
			typeof sl.tags === 'number' && typeof sl.body === 'number'
		) {
			idx.sumLen = {
				title: sl.title,
				heading: sl.heading,
				tags: sl.tags,
				body: sl.body,
			};
		} else {
			// Recompute from docs as a fallback so a partially-corrupted
			// index can still be loaded usefully.
			idx.sumLen = { title: 0, heading: 0, tags: 0, body: 0 };
			for (const s of idx.docs.values()) {
				idx.sumLen.title += s.lens.title;
				idx.sumLen.heading += s.lens.heading;
				idx.sumLen.tags += s.lens.tags;
				idx.sumLen.body += s.lens.body;
			}
		}
		return idx;
	}
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
	return typeof x === 'object' && x !== null && !Array.isArray(x);
}
