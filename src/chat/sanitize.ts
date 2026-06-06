// Pure sanitizer for assistant Markdown. Runs before MarkdownRenderer.render
// on EVERY assistant turn, including each throttled streaming update.
// The point is to prevent the renderer from making network requests
// or revealing private content via embed transclusion. We are NOT a
// general-purpose HTML sanitizer — Obsidian's renderer already strips
// most dangerous HTML — but we belt-and-suspenders strip raw <img>,
// <iframe>, and unsafe-scheme href/src attributes too because the
// guarantees of Obsidian's HTML stripping are not stable across
// versions.

export interface SanitizeOptions {
	allowExternalImages: boolean;
}

// Pre-compile patterns once per module load. The orderings matter:
// data: images before external images so we don't classify them as http(s);
// embed `![[ ]]` before plain wikilinks so we strip the bang form.
//
// The image URL captures use `[^)\s]+` (no closing paren or whitespace)
// for the URL portion — a slight tightening over `[^)]+` that doesn't
// regress on common URLs. Schemes are matched case-insensitively (`/i`).
const EMBED_RE = /!\[\[(.+?)\]\]/g;
const DATA_IMAGE_RE = /!\[([^\]]*)\]\(\s*data:[^)\s]*\s*\)/gi;
const EXTERNAL_IMAGE_RE = /!\[([^\]]*)\]\(\s*(https?:\/\/[^)\s]+)\s*\)/gi;
// Image links carrying javascript:, vbscript:, or file: schemes.
// vbscript: was an IE-era scripting handler that some legacy renderers
// still surface; file: can read local resources via the renderer's
// resolver. Both are blocked alongside the existing data: rewrite path.
// `[^)\s]*` matches the URL portion (any non-paren, non-whitespace) so
// the closing `)` is consumed and the surrounding tokens don't leak
// through the replacement.
const UNSAFE_SCHEME_IMAGE_RE = /!\[([^\]]*)\]\(\s*(?:javascript|vbscript|file):[^)\s]*\s*\)/gi;
const JS_LINK_RE = /\[([^\]]*)\]\(\s*javascript:[^)]*\)/gi;
const DATA_LINK_RE = /\[([^\]]*)\]\(\s*data:[^)]*\)/gi;
// Additional unsafe-scheme link downgrades. Matches link form `[text](scheme:...)`.
const VBSCRIPT_LINK_RE = /\[([^\]]*)\]\(\s*vbscript:[^)]*\)/gi;
const FILE_LINK_RE = /\[([^\]]*)\]\(\s*file:[^)]*\)/gi;
// Reference-style link/image DEFINITIONS pointing at unsafe schemes.
// Markdown reference definitions look like `[ref]: <url> "title"` at
// the start of a line. We match javascript:, data:, vbscript:, and
// file: URLs and replace the URL with about:blank so the reference
// resolves to nothing.
const REF_DEF_UNSAFE_RE = /^(\s{0,3}\[[^\]]+\]:\s*)<?\s*(javascript|data|vbscript|file):[^\s>]*>?/gim;
// Autolinks <javascript:...>, <data:...>, <vbscript:...>, <file:...>.
const AUTOLINK_UNSAFE_RE = /<\s*(javascript|data|vbscript|file):[^>]*>/gi;
// Protocol-relative image URLs `//host/path.png`.
const PROTO_REL_IMAGE_RE = /!\[([^\]]*)\]\(\s*\/\/[^)\s]+\s*\)/g;
// Raw HTML tags we always strip from the markdown source. Even if the
// renderer would normally honor or sanitize them, dropping them at the
// source means we don't depend on renderer behavior.
const RAW_IMG_RE = /<img\b[^>]*>/gi;
const RAW_IFRAME_RE = /<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi;
const RAW_SCRIPT_RE = /<script\b[^>]*>[\s\S]*?<\/script>/gi;
// href= / src= / srcset= attributes carrying unsafe schemes inside
// surviving HTML. We rewrite the attribute value to about:blank.
const RAW_UNSAFE_ATTR_RE = /(href|src|srcset)\s*=\s*("|')\s*(javascript|data|vbscript|file):[^"']*\2/gi;
// HTML event-handler attributes (onclick=..., onerror=..., etc.).
// Some models legitimately emit raw HTML like `<details>`, `<sup>`,
// `<kbd>` — those tags are harmless. The minimum-cost defense is to
// strip ANY `on<event>="..."` (case-insensitive) attribute from any
// tag without removing the tag itself. Single AND double-quoted values
// are matched; exactly one leading whitespace char is consumed to keep
// the remaining tag well-formed (no double spaces between attrs).
//
// IMPORTANT: the opener consumes a SINGLE whitespace char (`\s`), NOT
// `\s+`. A `\s+` opener exhibits catastrophic O(n^2) backtracking on
// long runs of whitespace without a subsequent valid handler — the
// engine tries every whitespace boundary, then backtracks the
// alternation `("[^"]*"|'[^']*')` and starts again at the next index.
// Measured on Node 22 with the old `\s+` form: 5 KB whitespace = 13 ms,
// 50 KB = 1 s, 100 KB = 4 s. Since sanitize runs on every throttled
// streaming tick (~33 ms cadence), a model emitting a whitespace-heavy
// block (indented code fence, ASCII art) would pin the renderer. The
// single-`\s` form is linear time and matches the same set of strings
// because real handler attributes are always preceded by at least one
// whitespace char in well-formed HTML.
const RAW_EVENT_HANDLER_RE = /(\s)on[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi;
// Bidi control characters that can spoof hostnames.
const BIDI_CONTROL_RE = /[‪-‮⁦-⁩]/g;

export function sanitizeAssistantMarkdown(
	md: string,
	opts: SanitizeOptions,
): string {
	let out = md;

	// 1. Strip Obsidian embed syntax `![[ ... ]]` — this would silently
	//    transclude potentially private vault content into the chat
	//    transcript. Plain wikilinks `[[ ]]` are NOT stripped — they
	//    render as click-only links per the plan.
	out = out.replace(EMBED_RE, (_full, target: string) => {
		const trimmed = target.trim().split('|')[0]?.trim() ?? '';
		return `[embed stripped: ${trimmed}]`;
	});

	// 2. data:-URI images. Always blocked — there is no scenario in
	//    which an assistant should be injecting base64 images into
	//    a vault note.
	out = out.replace(DATA_IMAGE_RE, () => `[blocked data image]`);

	// 3. External http(s) images. The renderer would fire a network
	//    request to fetch them on render, which is a tracking-pixel
	//    vector. Setting `allowExternalImages` opts back in.
	if (!opts.allowExternalImages) {
		out = out.replace(EXTERNAL_IMAGE_RE, (_full, _alt: string, url: string) => {
			const host = safeHostname(url);
			return `[blocked external image: ${host}]`;
		});
		// Protocol-relative `//host/...` — same tracking-pixel risk.
		out = out.replace(PROTO_REL_IMAGE_RE, () => `[blocked external image]`);
	}

	// 4a. Image links carrying unsafe schemes (javascript:/vbscript:/file:).
	//    Keeps the trailing data:-image case to step 2 (which surfaces a
	//    distinct `[blocked data image]` notice); these three schemes are
	//    rarer and grouped together so the surfaced text stays uniform.
	out = out.replace(UNSAFE_SCHEME_IMAGE_RE, () => `[blocked unsafe-scheme image]`);

	// 4b. javascript:-URI links. The renderer is supposed to drop these
	//    already (per Obsidian testing) but defense in depth is cheap.
	out = out.replace(JS_LINK_RE, (_full, text: string) => `${text} (javascript URL blocked)`);

	// 5. data:-URI links — same logic as data images, plus they can
	//    embed huge inline payloads that bloat the transcript.
	out = out.replace(DATA_LINK_RE, (_full, text: string) => `${text} (data URL blocked)`);

	// 5b. vbscript:- and file:-URI links. vbscript is a legacy IE handler
	//     that some renderers historically honored; file: can dereference
	//     local OS paths via the renderer's URL resolver. Both are blocked
	//     with link text preserved for visual continuity.
	out = out.replace(VBSCRIPT_LINK_RE, (_full, text: string) => `${text} (vbscript URL blocked)`);
	out = out.replace(FILE_LINK_RE, (_full, text: string) => `${text} (file URL blocked)`);

	// 6. Reference-style link definitions with unsafe schemes
	//    (javascript: / data: / vbscript: / file:).
	out = out.replace(REF_DEF_UNSAFE_RE, (_full, prefix: string) => `${prefix}about:blank`);

	// 7. Autolinks pointing at javascript: / data: / vbscript: / file:.
	out = out.replace(AUTOLINK_UNSAFE_RE, '<about:blank>');

	// 8. Raw HTML belt-and-suspenders: strip <img>, <iframe>, <script>
	//    and neutralize unsafe attribute schemes in anything that
	//    survives. Markdown allows raw HTML and Obsidian's renderer
	//    has historically passed certain tags through.
	out = out.replace(RAW_SCRIPT_RE, '');
	out = out.replace(RAW_IFRAME_RE, '');
	out = out.replace(RAW_IMG_RE, '[blocked html image]');
	out = out.replace(RAW_UNSAFE_ATTR_RE, (_full, attr: string, _q: string) => `${attr}="about:blank"`);
	// 8b. Strip HTML event-handler attributes (onclick, onerror, onload,
	//     onmouseover, etc.) from any surviving tag. We don't drop the
	//     tag itself because some assistants legitimately emit harmless
	//     `<details>`, `<sup>`, `<kbd>` tags; the minimum-cost defense
	//     is to neutralize the handler attribute while preserving the
	//     wrapping element so the surrounding markdown still parses.
	out = out.replace(RAW_EVENT_HANDLER_RE, '');

	return out;
}

function safeHostname(url: string): string {
	// We use the URL constructor where available, fall back to a
	// hand-rolled extraction if the input isn't a parseable URL.
	let host: string;
	try {
		host = new URL(url).hostname;
	} catch (_e) {
		const m = /^https?:\/\/([^/?#]+)/i.exec(url);
		host = m?.[1] ?? 'unknown';
	}
	// Strip bidi control characters to prevent display spoofing.
	return host.replace(BIDI_CONTROL_RE, '');
}
