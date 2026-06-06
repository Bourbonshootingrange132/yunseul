// Translate the lifecycle module's tagged-union outcome into the
// StreamChatOpts onComplete/onError contract.
//
// Kept as a separate module (not inlined into lifecycle.ts) because the
// lifecycle module is purely about subprocess timing; the dispatch is
// about upstream callback semantics (the StreamChatOpts shape), which
// lives in the LLMClient surface, not the subprocess layer. Splitting
// them keeps each module aligned with one concern.

import { redactSecrets } from '../util/redact';
import type { StreamChatOpts, StreamCompletionMeta } from '../llm/types';
import { STDERR_MAX_CHARS, STDERR_TRUNCATION_MARKER } from './constants';
import type { LifecycleOutcome } from './lifecycle';

/**
 * Dispatch the lifecycle outcome to opts.onComplete or opts.onError per
 * the tagged-union kind. Caller is responsible for any cleanup work
 * (sysprompt unlink, ndjson flush, etc.) BEFORE invoking this — the
 * dispatch is pure callback translation.
 *
 *   - 'complete' / 'aborted':  fire opts.onComplete({...meta}). Aborted
 *     mirrors LM Studio's abort path: treat as a clean completion so
 *     partial content stays visible.
 *   - 'spawn-throw' / 'spawn-enoent' / 'spawn-error' / 'exit-error':
 *     fire opts.onError with a human-readable message. ENOENT carries a
 *     specific hint pointing the user at the binary path setting.
 *     'exit-error' redacts and truncates the stderr tail so credentials
 *     don't leak into the bubble and the error string stays readable.
 */
export function dispatchTerminate(
	outcome: LifecycleOutcome,
	binary: string,
	meta: StreamCompletionMeta,
	opts: StreamChatOpts,
): void {
	switch (outcome.kind) {
		case 'complete':
		case 'aborted':
			opts.onComplete({ ...meta });
			return;
		case 'spawn-throw':
			opts.onError(new Error(`Failed to spawn \`${binary}\`: ${outcome.message}`));
			return;
		case 'spawn-enoent':
			opts.onError(new Error(`\`${binary}\` not found. Configure the Claude binary path in Settings.`));
			return;
		case 'spawn-error':
			opts.onError(new Error(`Subprocess error: ${outcome.message}`));
			return;
		case 'exit-error': {
			const safeStderr = redactSecrets(outcome.stderrTail);
			const truncated = safeStderr.length > STDERR_MAX_CHARS
				? `${safeStderr.slice(0, STDERR_MAX_CHARS)}${STDERR_TRUNCATION_MARKER}`
				: safeStderr;
			const detail = truncated.trim().length > 0 ? `: ${truncated.trim()}` : '';
			opts.onError(new Error(`claude exited with code ${outcome.exitCode}${detail}`));
			return;
		}
	}
}
