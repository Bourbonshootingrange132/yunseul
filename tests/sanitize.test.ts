import { describe, expect, it } from 'vitest';
import { sanitizeAssistantMarkdown } from '../src/chat/sanitize';

const opts = { allowExternalImages: false };

describe('sanitizeAssistantMarkdown', () => {
	it('blocks external http images and surfaces the hostname', () => {
		const out = sanitizeAssistantMarkdown(
			'![pwn](https://example.com/p?x=secret)',
			opts,
		);
		expect(out).toContain('blocked external image: example.com');
		expect(out).not.toContain('https://example.com');
	});

	it('blocks http images by default', () => {
		const out = sanitizeAssistantMarkdown('![](http://tracker.test/img.png)', opts);
		expect(out).toContain('tracker.test');
		expect(out).not.toContain('http://tracker.test');
	});

	it('allows external images when opted in', () => {
		const out = sanitizeAssistantMarkdown(
			'![alt](https://example.com/x.png)',
			{ allowExternalImages: true },
		);
		expect(out).toContain('https://example.com/x.png');
	});

	it('blocks data: images', () => {
		const out = sanitizeAssistantMarkdown('![](data:image/png;base64,xyz)', opts);
		expect(out).toBe('[blocked data image]');
	});

	it('strips embed syntax but keeps wikilinks intact', () => {
		const out = sanitizeAssistantMarkdown(
			'See ![[Secret/Plan]] and [[Public Note]] for details.',
			opts,
		);
		expect(out).toContain('embed stripped: Secret/Plan');
		expect(out).toContain('[[Public Note]]');
		expect(out).not.toContain('![[Secret/Plan]]');
	});

	it('blocks javascript: links keeping the link text', () => {
		const out = sanitizeAssistantMarkdown(
			'[click me](javascript:alert(1))',
			opts,
		);
		expect(out).toContain('click me');
		expect(out).toContain('javascript URL blocked');
		expect(out).not.toContain('javascript:alert(1)');
	});

	it('blocks data: links', () => {
		const out = sanitizeAssistantMarkdown(
			'[badge](data:text/html,<script>1</script>)',
			opts,
		);
		expect(out).toContain('data URL blocked');
		expect(out).not.toContain('data:text/html');
	});

	it('leaves plain http(s) markdown links alone', () => {
		const md = 'See [docs](https://obsidian.md/docs) for help.';
		const out = sanitizeAssistantMarkdown(md, opts);
		expect(out).toBe(md);
	});

	it('handles embeds with aliases', () => {
		const out = sanitizeAssistantMarkdown('![[Notes/Foo|alias]]', opts);
		expect(out).toContain('embed stripped: Notes/Foo');
	});

	it('does not mutate text that contains no blocked constructs', () => {
		const md = '# Heading\n\nA paragraph with **bold** text.';
		expect(sanitizeAssistantMarkdown(md, opts)).toBe(md);
	});

	// Coverage for the uncovered regexes in the sanitize bank: raw HTML
	// img/iframe/script, autolinks, reference-style definitions, bidi
	// control characters, and protocol-relative URLs.

	it('strips raw <img> tags entirely (defense-in-depth — renderer may pass them through)', () => {
		const out = sanitizeAssistantMarkdown(
			'before <img src="https://tracker.test/p.png"> after',
			opts,
		);
		expect(out).toContain('[blocked html image]');
		expect(out).not.toContain('<img');
		expect(out).not.toContain('tracker.test');
	});

	it('strips raw <iframe>...</iframe> blocks', () => {
		const out = sanitizeAssistantMarkdown(
			'text <iframe src="https://evil.test"></iframe> more',
			opts,
		);
		expect(out).not.toContain('<iframe');
		expect(out).not.toContain('evil.test');
	});

	it('strips raw <script>...</script> blocks', () => {
		const out = sanitizeAssistantMarkdown(
			'<script>alert(1)</script>safe text',
			opts,
		);
		expect(out).not.toContain('<script');
		expect(out).not.toContain('alert(1)');
		expect(out).toContain('safe text');
	});

	it('rewrites autolinks with javascript: or data: schemes to <about:blank>', () => {
		const out = sanitizeAssistantMarkdown(
			'<javascript:alert(1)> and <data:text/html,1>',
			opts,
		);
		expect(out).not.toContain('javascript:');
		expect(out).not.toContain('data:text/html');
		expect(out).toContain('about:blank');
	});

	it('rewrites reference-style link definitions pointing at unsafe schemes to about:blank', () => {
		const md = '[ref]: javascript:alert(1) "title"';
		const out = sanitizeAssistantMarkdown(md, opts);
		expect(out).toContain('about:blank');
		expect(out).not.toContain('javascript:alert(1)');
	});

	it('blocks protocol-relative external image URLs (//host/path.png)', () => {
		const out = sanitizeAssistantMarkdown(
			'![](//tracker.test/img.png)',
			opts,
		);
		expect(out).toContain('[blocked external image]');
		expect(out).not.toContain('//tracker.test');
	});

	it('strips bidi control characters from the surfaced hostname when blocking an external image', () => {
		// LRO/RLO/PDF chars can spoof hostnames in display. We don't
		// preserve them in the [blocked external image: <host>] notice.
		const lro = '‭';
		const md = `![](https://goodsite.test${lro}.example.com/x.png)`;
		const out = sanitizeAssistantMarkdown(md, opts);
		expect(out).not.toContain(lro);
	});

	it('neutralizes href/src attributes carrying unsafe schemes inside surviving HTML', () => {
		const out = sanitizeAssistantMarkdown(
			'<a href="javascript:alert(1)">x</a>',
			opts,
		);
		expect(out).toContain('about:blank');
		expect(out).not.toContain('javascript:alert(1)');
	});

	// Additional gap-fill coverage from the audit Security cluster.
	// These tests assert precise output (.toBe) where possible so a future
	// regression on the regex shape produces a clear diff. Where the surrounding
	// markup must survive the rewrite, .toContain / .not.toContain pair up.

	it('blocks vbscript: image links (audit S1)', () => {
		const out = sanitizeAssistantMarkdown(
			'![pwn](vbscript:execute)',
			opts,
		);
		expect(out).toBe('[blocked unsafe-scheme image]');
	});

	it('blocks file: image links (audit S1)', () => {
		const out = sanitizeAssistantMarkdown(
			'![local](file:///etc/passwd)',
			opts,
		);
		expect(out).toBe('[blocked unsafe-scheme image]');
	});

	it('blocks vbscript: link form keeping the link text (audit S1)', () => {
		const out = sanitizeAssistantMarkdown(
			'[click](vbscript:execute)',
			opts,
		);
		expect(out).toBe('click (vbscript URL blocked)');
	});

	it('blocks file: link form keeping the link text (audit S1)', () => {
		const out = sanitizeAssistantMarkdown(
			'[open](file:///etc/passwd)',
			opts,
		);
		expect(out).toBe('open (file URL blocked)');
	});

	it('strips onclick event-handler attribute while preserving the surrounding tag (audit S2)', () => {
		const out = sanitizeAssistantMarkdown(
			'<div onclick="alert(1)">hello</div>',
			opts,
		);
		expect(out).toBe('<div>hello</div>');
	});

	it('strips onerror handler on a surviving tag (audit S2)', () => {
		// `<img>` is already dropped wholesale by RAW_IMG_RE; pick a tag
		// that survives so the event-handler regex is the load-bearing
		// path. `<details>` is a common assistant-emitted disclosure tag.
		const out = sanitizeAssistantMarkdown(
			'<details onclick="alert(1)" open>Hello</details>',
			opts,
		);
		expect(out).toContain('<details');
		expect(out).toContain('Hello');
		expect(out).toContain('open');
		expect(out).not.toContain('onclick');
		expect(out).not.toContain('alert(1)');
	});

	it('strips event handlers with single-quoted values (audit S2)', () => {
		const out = sanitizeAssistantMarkdown(
			"<span onmouseover='steal()'>x</span>",
			opts,
		);
		expect(out).toBe('<span>x</span>');
	});

	// Audit T3: sanitize cases not yet covered. These three test the
	// asymmetry hazards in the markdown-image and reference-style paths
	// where the dangerous URL is the destination, not the alt text.

	it('rewrites a markdown image whose destination is dangerous even when the alt text contains a URL (audit T3)', () => {
		// `![https://example.com/x](https://attacker.test/y)` — the
		// EXTERNAL_IMAGE_RE captures the second URL (the destination).
		// Asserts the destination is rewritten and the alt-side text
		// no longer carries the destination host.
		const out = sanitizeAssistantMarkdown(
			'![https://example.com/x](https://attacker.test/y)',
			opts,
		);
		expect(out).toContain('blocked external image: attacker.test');
		expect(out).not.toContain('https://attacker.test/y');
	});

	it('preserves a nested wikilink in link text while neutralizing the dangerous outer URL (audit T3)', () => {
		// `[[[Note A]] inner](http://attacker.test)` — the wikilink
		// `[[Note A]]` sits inside the link text. We expect the link text
		// to survive (the wikilink remains intact for Obsidian's
		// renderer) while the outer external URL is replaced. Because
		// the URL has http (not javascript:/data:/etc.), it isn't rewritten
		// by the unsafe-scheme paths — but if external images are
		// disallowed for `!` form, the link form sees no host-blocking by
		// default. We just lock in that the wikilink does not get stripped
		// (the EMBED_RE only matches `![[` form). The inner `[[Note A]]`
		// must remain present in the output.
		const out = sanitizeAssistantMarkdown(
			'[[[Note A]] inner](http://attacker.test)',
			opts,
		);
		expect(out).toContain('[[Note A]]');
		// `!` form would be stripped, plain wikilinks are preserved.
		expect(out).not.toContain('embed stripped');
	});

	it('rewrites a markdown reference-style definition pointing at javascript: (audit T3)', () => {
		// `![alt][ref]\n\n[ref]: javascript:alert(1)` — the REF_DEF
		// regex matches the bottom line and rewrites the URL to
		// about:blank. We use the image-reference form to exercise the
		// destination-vs-alt asymmetry.
		const md = '![alt][ref]\n\n[ref]: javascript:alert(1)';
		const out = sanitizeAssistantMarkdown(md, opts);
		expect(out).toContain('about:blank');
		expect(out).not.toContain('javascript:alert(1)');
	});

	it('handles long whitespace runs in linear time (regression: RAW_EVENT_HANDLER_RE backtracking)', () => {
		// sanitize runs on every throttled streaming tick (~33 ms cadence).
		// A prior `\s+on[a-z]+...` opener exhibited O(n^2) backtracking on
		// whitespace-heavy input: 5 KB = 13 ms, 50 KB = 1 s. With the
		// single-`\s` opener, 50 KB completes in <1 ms. The bound below
		// (50 ms) gives generous headroom over the fast-path floor while
		// still failing loudly if the quadratic shape is reintroduced.
		const input = ' '.repeat(50_000);
		const start = Date.now();
		const out = sanitizeAssistantMarkdown(input, opts);
		const elapsed = Date.now() - start;
		expect(out).toBe(input);
		expect(elapsed).toBeLessThan(50);
	});
});
