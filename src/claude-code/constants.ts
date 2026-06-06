// Pure constants for the Claude Code subprocess client. Kept in a leaf
// module with no node/obsidian imports so every other claude-code
// submodule (env, ndjson, sysprompt, lifecycle, probe) can pull them in
// without forming an import cycle through the orchestrator (client.ts).
//
// STDERR_MAX_CHARS and STDERR_TRUNCATION_MARKER are re-exported from
// client.ts for back-compat with tests/claude-code.test.ts (those
// imports name the symbols by path '../src/claude-code/client').

// SIGTERM → wait → SIGKILL backoff. After the user hits Stop, give
// the subprocess a chance to clean up before escalating. 2 seconds
// matches the spec.
export const SIGTERM_TO_SIGKILL_MS = 2000;

// Stderr truncation cap when surfacing it inside an Error message.
// 500 chars is enough to see the headline failure (auth missing, CLI
// crash) without dumping kilobytes into a Notice. Exported so tests
// can lock in the actual cap value rather than asserting on an
// arbitrary ceiling.
export const STDERR_MAX_CHARS = 500;

// Marker overhead is the literal `...[truncated]` suffix appended when
// the raw stderr exceeds STDERR_MAX_CHARS. Exported alongside so tests
// can compute the maximum surfaced-error length precisely.
export const STDERR_TRUNCATION_MARKER = '...[truncated]';

// Upper bound on the live stderr buffer so a misbehaving CLI that spams
// MB of warnings doesn't accumulate the whole stream in memory. We keep
// the tail (the most recent output is usually the relevant error) once
// the buffer crosses this size.
export const STDERR_BUFFER_MAX = 8 * 1024;

// Upper bound on a single NDJSON line so a malicious or runaway upstream
// can't blast multi-MB lines into JSON.parse and stall the renderer.
export const STDOUT_LINE_MAX = 1024 * 1024;

// Upper bound on the cumulative stdout buffer (the in-progress partial
// line being assembled across data chunks). If we cross this without
// seeing a newline we abandon parsing.
export const STDOUT_BUFFER_MAX = 8 * 1024 * 1024;

// Probe timeout. `claude --version` is supposed to exit immediately,
// but a wrapper script with an interactive prompt could hang the probe
// forever; cap at 10 seconds.
export const PROBE_TIMEOUT_MS = 10_000;

// Strict patterns for argv values that come from upstream/persisted
// state. Session ids should be UUID-shaped; we accept a slightly broader
// alphabet for forward-compat with future CLI changes but cap at 128
// chars. Model overrides allow colons and slashes for namespaced model
// ids (e.g. `bedrock/anthropic.claude-...`). Both reject a leading
// `-` so a tampered value like `--allowedTools` can never be parsed by
// the CLI as a flag. The first char must be an alphanumeric; remaining
// chars can include the punctuation set we tolerate. We use two
// alternatives: a single char OR (first-char then up-to-127 tail chars).
export const SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,127})$/;
export const MODEL_OVERRIDE_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:/-]{0,127})$/;
