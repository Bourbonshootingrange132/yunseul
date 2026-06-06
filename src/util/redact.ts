// Unified secret redaction. Both the LM Studio HTTP client and the
// Claude Code subprocess client had their own redactSecrets functions
// before this module existed; the patterns drifted (LM Studio missed
// `sk-ant-*`, JWT, and Cookie patterns; Claude Code missed user-named
// `apiKey=`/`api_key=` forms). Both clients now import `redactSecrets`
// from here so a new credential pattern only needs to land in one
// place.
//
// The function is defensive against pathological inputs: a multi-MB
// stderr blob from a misbehaving subprocess gets sliced to 8 KB before
// regex evaluation so the global-replace passes don't pin the renderer
// thread. The slice is conservative — 8 KB is enough to capture the
// last error headline (auth missing, CLI crash) without surfacing the
// user's entire vault that may have been echoed through stdout.

// Hard cap on input size before regex evaluation. Inputs longer than
// this are truncated to the head and tagged with a marker so the
// caller can see truncation happened. 8 KB matches the Claude Code
// stderr buffer cap; anything bigger is almost certainly a runaway
// subprocess dumping the world to stderr.
const REDACTION_INPUT_MAX = 8 * 1024;
const REDACTION_TRUNCATION_MARKER = '...[truncated for redaction]';

/**
 * Redact common credential patterns from a string before logging or
 * surfacing in a user-visible error. The matchers, in order:
 *
 *   - `Authorization: <header value>` — header form
 *   - `Bearer <token>` — bare token (caught after Authorization so the
 *     header form takes precedence)
 *   - `x-api-key: ...` — header form for Anthropic etc.
 *   - `Cookie: ...` / `Set-Cookie: ...`
 *   - `sk-ant-...` — Anthropic console-style API keys
 *   - `sk-[A-Za-z0-9]{20,}` — OpenAI-style API keys
 *   - JWT three-part `eyJ...eyJ...sig` tokens
 *   - `apiKey=...` / `api_key=...` — custom-named key forms (case-insensitive)
 *
 * Bounds input size to defend against pathological regex inputs. Long
 * inputs are sliced to the head (most error stack-traces have the
 * relevant data near the start) and tagged with a truncation marker.
 */
export function redactSecrets(s: string): string {
	let out = s.length > REDACTION_INPUT_MAX
		? `${s.slice(0, REDACTION_INPUT_MAX)}${REDACTION_TRUNCATION_MARKER}`
		: s;
	// Header forms before bare-token forms so the surrounding header
	// name is included in the replacement (otherwise the bare-Bearer
	// pattern would consume the token but leave the `Authorization:`
	// prefix dangling).
	out = out.replace(/Authorization:\s*[^\r\n]+/gi, 'Authorization: [REDACTED]');
	out = out.replace(/x-api-key:\s*[^\r\n]+/gi, 'x-api-key: [REDACTED]');
	out = out.replace(/Cookie:\s*[^\r\n]+/gi, 'Cookie: [REDACTED]');
	out = out.replace(/Set-Cookie:\s*[^\r\n]+/gi, 'Set-Cookie: [REDACTED]');
	// Bare bearer tokens. `\S+` matches any non-whitespace; the prior
	// header pass already consumed Authorization-line forms so this only
	// catches free-floating `Bearer <token>` in error bodies.
	out = out.replace(/Bearer\s+\S+/g, 'Bearer [REDACTED]');
	// Anthropic console keys. Always shaped `sk-ant-…`; matches more
	// chars than the generic sk- rule below so it runs first.
	out = out.replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-[REDACTED]');
	// OpenAI-style API keys. 20-char minimum body so we don't false-
	// positive on `sk-1234` short strings in error messages.
	out = out.replace(/sk-[A-Za-z0-9]{20,}/g, 'sk-[REDACTED]');
	// Three-part JWT eyJ…eyJ…sig tokens. Total length cap is a soft
	// guard — JWTs are typically 100+ chars.
	out = out.replace(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[JWT-REDACTED]');
	// User-named key forms — apiKey=… and api_key=… (case-insensitive
	// for both the key name and the surrounding quoting).
	out = out.replace(/api[-_]?key["']?\s*[:=]\s*["']?[A-Za-z0-9._\-+/=]+/gi, 'api_key=[REDACTED]');
	return out;
}

/**
 * Redact a specific literal token (the user's configured apiKey, for
 * example) on top of the generic pattern bank. Builds a global regex
 * from the escaped token. Bound the token length used in the dynamic
 * regex to defend against pathological apiKey values (a user pasting
 * an entire log file into the field).
 */
export function redactWithLiteralKey(s: string, key: string): string {
	const trimmed = key.trim();
	let base = redactSecrets(s);
	if (trimmed.length === 0) return base;
	// Cap dynamic-regex input length. A user with a literal apiKey
	// longer than this likely has the wrong field anyway; the generic
	// patterns above still catch the headline forms.
	const bounded = trimmed.length > 256 ? trimmed.slice(0, 256) : trimmed;
	const escaped = bounded.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	base = base.replace(new RegExp(escaped, 'g'), '[REDACTED]');
	return base;
}
