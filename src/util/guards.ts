// Shared guards previously duplicated across main.ts, chat/session.ts,
// claude-code/client.ts, lmstudio/client.ts, lmstudio/types.ts,
// chat/persist.ts and index/retriever.ts. Consolidating them removes the
// drift hazard where one path's isAbortError handled DOMException but
// another path's didn't (audit Arch1 finding). When merging, we keep
// the BROADEST implementation: isAbortError adopts the variant from
// claude-code/client.ts that handles DOMException + Error.name +
// /aborted/i message; makeNonce adopts the cryptographically-random
// randomUUID() variant from claude-code/client.ts so collision-paradox
// windows close and the sysprompt symlink-prediction surface narrows.
//
// Pure module — depends on Node's `crypto` built-in (Electron renderer
// exposes it; esbuild's `builtinModules` external list keeps it out of
// the bundle). No Obsidian import. Safe to import from anywhere in src/.
import { randomUUID } from 'crypto';

/**
 * True iff the value is a non-null object. Used as a guard before
 * indexing into an unknown-shaped payload (NDJSON parse output, settings
 * load, untrusted server JSON, etc.).
 */
export function isObject(x: unknown): x is Record<string, unknown> {
	return typeof x === 'object' && x !== null;
}

/**
 * True for any abort error: DOMException with name='AbortError' (the
 * fetch path), a plain Error with name='AbortError' (Node's signal
 * path), or any Error whose message matches /aborted/i (defensive — some
 * adapters surface aborts as "aborted by user" plaintext rather than via
 * the standard name). This is the broadest of the variants previously
 * scattered across modules; widening here narrows the per-module drift
 * surface.
 */
export function isAbortError(e: unknown): boolean {
	if (e instanceof DOMException && e.name === 'AbortError') return true;
	if (e instanceof Error && (e.name === 'AbortError' || /aborted/i.test(e.message))) return true;
	return false;
}

/**
 * Cryptographically-random short id. Used as a nonce in tmp-file
 * filenames (chat/persist.ts, index/retriever.ts, claude-code/client.ts).
 * crypto.randomUUID() is available on all supported Obsidian versions
 * (Electron ≥ 24) and eliminates the collision-paradox window that the
 * previous Math.random()-based variants opened when multiple writers
 * fired in the same tick.
 */
export function makeNonce(): string {
	return randomUUID();
}
