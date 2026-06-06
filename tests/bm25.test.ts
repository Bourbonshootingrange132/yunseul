import { describe, expect, it } from 'vitest';
import { BM25Index, tokenize } from '../src/index/bm25';

const mkFields = (
	overrides: Partial<{ title: string; heading: string; tags: string[]; body: string }> = {},
): { title: string; heading: string; tags: string[]; body: string } => ({
	title: overrides.title ?? '',
	heading: overrides.heading ?? '',
	tags: overrides.tags ?? [],
	body: overrides.body ?? '',
});

describe('tokenize', () => {
	it('lowercases tokens', () => {
		expect(tokenize('HELLO World')).toEqual(['hello', 'world']);
	});

	it('drops English stop-words', () => {
		// "the", "is", "a" should disappear; "lonely" survives.
		expect(tokenize('the cat is a lonely creature')).toEqual(['cat', 'lonely', 'creature']);
	});

	it('strips tokens shorter than 2 characters', () => {
		// `i` is a stop-word; `x`, `y`, `z` are short. `and`, `as`, `of` are
		// stop-words. `see` and `part` are the only survivors.
		expect(tokenize('I see x and y as part of z')).toEqual(['see', 'part']);
	});

	it('uses unicode-aware word boundary', () => {
		// CJK characters should not split per-char — they're letters
		// under \p{L} so they form a single token. Punctuation splits.
		const out = tokenize('hello, 안녕하세요 world!');
		expect(out).toContain('hello');
		expect(out).toContain('world');
		expect(out).toContain('안녕하세요');
	});

	it('returns empty array on empty input', () => {
		expect(tokenize('')).toEqual([]);
	});

	it('splits on hyphens and apostrophes', () => {
		// We chose strict splitting — `don't` → `don` + `t` (t dropped).
		expect(tokenize("don't worry")).toEqual(['don', 'worry']);
	});

	// Audit T1: tokenizer edge cases not covered by the 24 BM25 tests.
	// The tokenizer is documented to use a Unicode-aware word boundary
	// (`/[^\p{L}\p{N}]+/u`); these tests lock in what that means for
	// common multi-script inputs so a regression to ASCII \w+ is loud.

	it('drops emoji and keeps the surrounding ASCII tokens (audit T1)', () => {
		// Emoji are matched by \p{So} / \p{Symbol,Other}, not \p{L}/\p{N},
		// so the boundary regex treats them as splitters. `hello` and
		// `world` survive; the emoji itself is filtered.
		expect(tokenize('hello \u{1F44B} world')).toEqual(['hello', 'world']);
	});

	it('does not crash on a ZWJ-joined emoji cluster (audit T1)', () => {
		// 👨‍👩‍👧 is three code points joined by U+200D ZWJ. The tokenizer
		// must not throw on the cluster; it produces no tokens (none of
		// the code points are \p{L}/\p{N}). Locking the no-throw behavior
		// guards against a regression where the boundary regex misclasses
		// ZWJ and corrupts the split.
		expect(() => tokenize('\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}')).not.toThrow();
		expect(tokenize('\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}')).toEqual([]);
	});

	it('produces tokens for RTL scripts (Hebrew + Arabic) without garbling (audit T1)', () => {
		// Hebrew "שלום" and Arabic "كلام" are both pure \p{L}, so they
		// should survive intact as single tokens. The internal bidi
		// rendering of the source string doesn't affect the codepoint
		// sequence the regex sees.
		const out = tokenize('שלום كلام');
		expect(out).toContain('שלום');
		expect(out).toContain('كلام');
		// Defensive: the test must not accidentally claim arbitrary
		// extra tokens were produced.
		expect(out.length).toBe(2);
	});

	it('keeps each script as its own token in mixed-script input (audit T1)', () => {
		// `café` carries an accented letter (still \p{L}); `漢字` is two
		// CJK letters that the unicode boundary keeps as a single token;
		// `hello` is plain ASCII. All three survive after lowercasing.
		const out = tokenize('café 漢字 hello');
		expect(out).toContain('café');
		expect(out).toContain('漢字');
		expect(out).toContain('hello');
		expect(out.length).toBe(3);
	});
});

describe('BM25Index basic operations', () => {
	it('add + search returns relevance-ordered results', () => {
		const idx = new BM25Index();
		idx.add('a.md', mkFields({ body: 'rust programming language tutorial' }));
		idx.add('b.md', mkFields({ body: 'python programming language tutorial' }));
		idx.add('c.md', mkFields({ body: 'rust ownership and rust borrowing' }));

		const hits = idx.search('rust', 10);
		// c.md mentions rust twice; a.md once; b.md not at all.
		expect(hits[0]?.docId).toBe('c.md');
		expect(hits[1]?.docId).toBe('a.md');
		expect(hits.length).toBe(2);
	});

	it('size() reflects the number of documents', () => {
		const idx = new BM25Index();
		expect(idx.size()).toBe(0);
		idx.add('a.md', mkFields({ body: 'x y z' }));
		idx.add('b.md', mkFields({ body: 'p q r' }));
		expect(idx.size()).toBe(2);
	});
});

describe('BM25Index field weighting', () => {
	it('a term in the title scores higher than the same term only in the body', () => {
		const idx = new BM25Index();
		// Same word counts, different fields. The body-only doc has a
		// longer body so the contrast is sharper.
		idx.add('title-doc.md', mkFields({
			title: 'rust handbook',
			body: 'general programming notes nothing special',
		}));
		idx.add('body-doc.md', mkFields({
			title: 'general handbook',
			body: 'general programming rust notes nothing special',
		}));

		const hits = idx.search('rust', 10);
		expect(hits[0]?.docId).toBe('title-doc.md');
		const titleScore = hits[0]?.score ?? 0;
		const bodyScore = hits[1]?.score ?? 0;
		expect(titleScore).toBeGreaterThan(bodyScore);
	});

	it('matches tags even when body does not contain the term', () => {
		const idx = new BM25Index();
		idx.add('tagged.md', mkFields({
			title: 'random title',
			tags: ['javascript', 'web'],
			body: 'some unrelated body content here please',
		}));
		idx.add('untagged.md', mkFields({
			title: 'random title',
			tags: ['python'],
			body: 'some unrelated body content here please',
		}));

		const hits = idx.search('javascript', 10);
		expect(hits.length).toBe(1);
		expect(hits[0]?.docId).toBe('tagged.md');
	});
});

describe('BM25Index query handling', () => {
	it('returns empty result on empty query', () => {
		const idx = new BM25Index();
		idx.add('a.md', mkFields({ body: 'something here' }));
		expect(idx.search('', 10)).toEqual([]);
	});

	it('filters stop-words from the query — "the" matches nothing', () => {
		const idx = new BM25Index();
		idx.add('a.md', mkFields({ body: 'the the the the and the for' }));
		expect(idx.search('the', 10)).toEqual([]);
	});

	it('respects topK — at most K results', () => {
		const idx = new BM25Index();
		for (let i = 0; i < 5; i++) {
			idx.add(`doc${i}.md`, mkFields({ body: 'rust rust rust' }));
		}
		const hits = idx.search('rust', 2);
		expect(hits.length).toBe(2);
	});

	it('returns matchedTerms only for terms that actually matched', () => {
		const idx = new BM25Index();
		idx.add('a.md', mkFields({ body: 'rust programming language' }));
		const hits = idx.search('rust unknownword python', 5);
		expect(hits).toHaveLength(1);
		expect(hits[0]?.matchedTerms).toEqual(['rust']);
	});
});

describe('BM25Index incremental updates', () => {
	it('remove() drops the doc from subsequent searches', () => {
		const idx = new BM25Index();
		idx.add('a.md', mkFields({ body: 'unique-token here' }));
		expect(idx.search('unique-token', 10).length).toBe(1);
		idx.remove('a.md');
		expect(idx.search('unique-token', 10).length).toBe(0);
		expect(idx.size()).toBe(0);
	});

	it('remove() is a no-op for a non-existent doc', () => {
		const idx = new BM25Index();
		idx.add('a.md', mkFields({ body: 'hello' }));
		idx.remove('missing.md');
		expect(idx.size()).toBe(1);
	});

	it('replace() updates the doc atomically', () => {
		const idx = new BM25Index();
		idx.add('a.md', mkFields({ body: 'first content rust' }));
		idx.replace('a.md', mkFields({ body: 'second content python' }));
		expect(idx.search('rust', 10).length).toBe(0);
		expect(idx.search('python', 10).length).toBe(1);
		expect(idx.size()).toBe(1);
	});

	it('add() on an existing doc replaces rather than duplicating', () => {
		const idx = new BM25Index();
		idx.add('a.md', mkFields({ body: 'alpha' }));
		idx.add('a.md', mkFields({ body: 'beta' }));
		expect(idx.size()).toBe(1);
		expect(idx.search('alpha', 10).length).toBe(0);
		expect(idx.search('beta', 10).length).toBe(1);
	});
});

describe('BM25Index serialization', () => {
	it('toJSON → fromJSON round-trip yields the same search results', () => {
		const idx = new BM25Index();
		idx.add('a.md', mkFields({ title: 'rust handbook', body: 'rust ownership rules' }));
		idx.add('b.md', mkFields({ body: 'python tutorial covering classes' }));
		idx.add('c.md', mkFields({ title: 'mixed', tags: ['rust', 'beginner'], body: 'examples' }));

		const json = JSON.parse(JSON.stringify(idx.toJSON()));
		const restored = BM25Index.fromJSON(json);

		const before = idx.search('rust', 10);
		const after = restored.search('rust', 10);
		expect(after.length).toBe(before.length);
		for (let i = 0; i < before.length; i++) {
			expect(after[i]?.docId).toBe(before[i]?.docId);
			expect(after[i]?.score).toBeCloseTo(before[i]?.score ?? 0, 9);
		}
	});

	it('fromJSON rejects unsupported schema versions', () => {
		expect(() => BM25Index.fromJSON({ schemaVersion: 999 })).toThrow();
		expect(() => BM25Index.fromJSON(null)).toThrow();
		expect(() => BM25Index.fromJSON('garbage')).toThrow();
	});

	it('scoring is deterministic — same input, same scores', () => {
		const build = (): BM25Index => {
			const i = new BM25Index();
			i.add('a.md', mkFields({ title: 'one rust note', body: 'about rust details' }));
			i.add('b.md', mkFields({ body: 'no relevant content here at all' }));
			i.add('c.md', mkFields({ tags: ['rust'], body: 'tagged content' }));
			return i;
		};
		const r1 = build().search('rust', 10);
		const r2 = build().search('rust', 10);
		expect(r1.length).toBe(r2.length);
		for (let i = 0; i < r1.length; i++) {
			expect(r1[i]?.docId).toBe(r2[i]?.docId);
			expect(r1[i]?.score).toBe(r2[i]?.score);
		}
	});
});

describe('BM25Index partial-build invariants', () => {
	// Pinned to audit finding #5 (main.ts startVaultIndexBuild rollback).
	// The integration-level rollback lives in startVaultIndexBuild — the
	// instance left behind by an aborted build is restored to the previous
	// retriever's index, not the partial one. This unit-level invariant
	// just locks in the BM25Index-level guarantee that a partial-build
	// state is well-formed and round-trippable so any save() that DOES
	// land on disk doesn't corrupt the persistent index file.
	it('an index populated with only the first N docs before "abort" still searches correctly', () => {
		// Per-doc unique terms chosen as ASCII letter strings so the
		// tokenizer (which splits on non-letter/number boundaries) keeps
		// them whole. We avoid hyphens because the tokenizer treats them
		// as boundaries and would merge the prefix across docs.
		const perDocToken = ['epsilonword', 'zetaword', 'etaword', 'thetaword', 'iotaword', 'kappaword', 'lambdaword', 'muword', 'nuword', 'xiword'];
		const total = perDocToken.length;
		const idx = new BM25Index();
		// Simulate the buildFromVault loop being aborted after N docs.
		const N = 4;
		for (let i = 0; i < N; i++) {
			idx.add(`doc${i}.md`, mkFields({ body: `${perDocToken[i] ?? ''} alpha beta` }));
		}
		// Documents indexed before the abort point are searchable.
		expect(idx.size()).toBe(N);
		const aHits = idx.search('alpha', 20);
		expect(aHits.length).toBe(N);
		// A token that only appears in docs AFTER the abort point cannot
		// be found — the partial state is a "smaller true index", not a
		// corrupt one.
		for (let i = N; i < total; i++) {
			const futureToken = perDocToken[i] ?? '';
			expect(idx.search(futureToken, 5).length).toBe(0);
		}
		// Round-trip the partial state through toJSON/fromJSON to verify
		// the partial-state serialization is valid. A save() that lands
		// after an aborted build would produce this exact JSON; the next
		// load() must accept it without throwing.
		const json = JSON.parse(JSON.stringify(idx.toJSON()));
		const restored = BM25Index.fromJSON(json);
		expect(restored.size()).toBe(N);
		const restoredHits = restored.search('alpha', 20);
		expect(restoredHits.length).toBe(N);
	});
});
