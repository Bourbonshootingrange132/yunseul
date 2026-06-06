// Argv assembly for the Claude Code CLI subprocess.
//
// Pure module — takes already-validated inputs (sessionId, modelOverride)
// and the user's enableWrites toggle, returns the argv array. The
// orchestrator (client.ts) owns validation (SESSION_ID_PATTERN /
// MODEL_OVERRIDE_PATTERN) because it owns the warn-log surface for
// rejected values.

export interface ArgvInputs {
	sysPromptPath: string;
	priorSessionId: string | null;
	modelOverride: string | null;
	enableWrites: boolean;
}

/**
 * Assemble the argv array for `claude -p`. Order doesn't matter to the
 * CLI but we group flags by purpose for readability in the debug log.
 *
 *   - --append-system-prompt-file <path>:  the system prompt + injection
 *     guard, written to a temp file by the sysprompt module.
 *   - --resume <id>:  resume an existing CLI-side session by id (only
 *     when the caller passed a validated priorSessionId).
 *   - --allowedTools "Read,Grep,Glob[,Edit,Write]":  the CLI's
 *     tool allowlist. Read-only by default; writes opt in via settings.
 *   - --permission-mode acceptEdits:  accepts Edit/Write proposals
 *     without prompting inside the CLI (we can't deliver interactive
 *     confirmation from a non-interactive stdin). Only set when writes
 *     are enabled.
 *   - --model <id>:  optional override; the CLI picks its default when
 *     absent. Only set when the caller passed a validated modelOverride.
 */
export function assembleArgs(inputs: ArgvInputs): string[] {
	const args: string[] = ['-p'];
	args.push('--output-format', 'stream-json');
	args.push('--verbose');
	args.push('--include-partial-messages');
	args.push('--append-system-prompt-file', inputs.sysPromptPath);
	if (inputs.priorSessionId !== null) {
		args.push('--resume', inputs.priorSessionId);
	}
	const allowedTools = inputs.enableWrites ? 'Read,Grep,Glob,Edit,Write' : 'Read,Grep,Glob';
	args.push('--allowedTools', allowedTools);
	if (inputs.enableWrites) {
		args.push('--permission-mode', 'acceptEdits');
	}
	if (inputs.modelOverride !== null) {
		args.push('--model', inputs.modelOverride);
	}
	return args;
}
