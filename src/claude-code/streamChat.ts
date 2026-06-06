// streamChat orchestration for the Claude Code provider.
//
// Glues the extracted modules — env, ndjson, sysprompt, lifecycle,
// argv, dispatch, splitMessages — into the StreamChatOpts contract.
// Kept separate from client.ts so the LLMClient surface (constructor +
// killAll + listModels + probe + streamChat) stays a thin shell. The
// orchestration here is one stable function: take a plugin + IO + opts,
// drive the subprocess to completion.
//
// Why a separate module and not inlined in client.ts: streamChat is
// the biggest single function in the provider; co-locating it with the
// class skeleton bloated the file past the 300 LOC target. Extracting
// it as a pure function (with plugin + IO + liveProcs threaded in)
// preserves the test seam — the class still owns DEFAULT_IO and
// constructor wiring; this function only sees what the class passes.

import { Notice } from 'obsidian';
import type YunseulPlugin from '../main';
import { runtimeDir, vaultBasePath } from '../util/paths';
import { redactSecrets } from '../util/redact';
import type { StreamChatOpts, StreamCompletionMeta } from '../llm/types';
import { assembleArgs } from './argv';
import type { ClaudeCodeIO } from './io';
import { MODEL_OVERRIDE_PATTERN, SESSION_ID_PATTERN } from './constants';
import { dispatchTerminate } from './dispatch';
import { buildSafeEnv } from './env';
import { runSubprocess, type LiveProc } from './lifecycle';
import { NdjsonBuffer } from './ndjson';
import { readSessionIdFromExtras, splitMessages } from './splitMessages';
import { cleanupSysPromptFile, writeSysPromptFile } from './sysprompt';

export interface StreamChatDeps {
	plugin: YunseulPlugin;
	io: ClaudeCodeIO;
	registerLive: (entry: LiveProc) => void;
	unregisterLive: (entry: LiveProc) => void;
}

/**
 * Run one streamChat call end-to-end. Resolves only after the subprocess
 * settles (terminal callback fired) — the caller (ChatSession.send) must
 * see the in-flight stream for the full subprocess lifetime so Stop
 * works and concurrent sends are prevented.
 *
 * Surface that lives here (rather than in client.ts):
 *   - reading settings (binary, modelOverride, enableWrites)
 *   - resolving vaultBasePath as cwd (with error-surface on
 *     non-FileSystemAdapter)
 *   - validating sessionId + modelOverride against the strict patterns
 *   - splitting messages into system prompt + stdin payload
 *   - writing the system prompt to the temp file (and cleaning it up)
 *   - assembling argv via the argv module
 *   - wiring the NdjsonBuffer handlers to opts.onToken/onMeta + Notice
 *     + plugin.logger
 *   - wiring the lifecycle handlers to opts.onError/onComplete via
 *     dispatchTerminate, plus stderr-line redacted logging
 */
export async function streamChat(deps: StreamChatDeps, opts: StreamChatOpts): Promise<void> {
	const settings = deps.plugin.settings;
	const binary = settings.claudeCode.binary.trim().length > 0 ? settings.claudeCode.binary.trim() : 'claude';

	// Vault base path is required — we run the CLI with cwd = vault so
	// its file tools (Read/Edit) resolve note paths. On a non-
	// FileSystemAdapter setup this throws; surface to the caller as a
	// normal error rather than letting it bubble out of the promise
	// unhandled.
	let cwd: string;
	try {
		cwd = vaultBasePath(deps.plugin);
	} catch (e) {
		const err = e instanceof Error ? e : new Error(String(e));
		opts.onError(err);
		return;
	}

	// Validate sessionId + modelOverride against strict patterns. A
	// tampered session JSON or settings field could otherwise inject an
	// argv flag here. Rejected values warn-log and start a fresh session
	// or fall back to the CLI's default model respectively.
	const priorSessionId = validateSessionId(readSessionIdFromExtras(opts.extras), deps.plugin);
	const modelOverride = validateModelOverride(settings.claudeCode.modelOverride.trim(), deps.plugin);

	// Split messages into system prompt + user prompt body. PromptAssembler
	// emits a leading system message (default prompt + injection guard)
	// then either a `<vault_excerpt>` system message, retrieval system
	// messages, or the conversation history. System messages go into the
	// temp file; everything else is concatenated into the stdin payload.
	const { systemPrompt, userPrompt } = splitMessages(opts.messages, priorSessionId !== null);

	const sysPromptPath = await writeSysPromptFile(
		{
			io: deps.io,
			runtimeDir: runtimeDir(deps.plugin),
			vaultBasePath: cwd,
			warn: (m) => deps.plugin.logger.warn(m),
		},
		systemPrompt,
		priorSessionId,
	);

	const args = assembleArgs({
		sysPromptPath,
		priorSessionId,
		modelOverride,
		enableWrites: settings.claudeCode.enableWrites,
	});

	deps.plugin.logger.debug('claude-code spawn', { binary, args, cwd });

	// Per-call meta accumulator. The NDJSON parser fires onSystemInit
	// and onResult as the events arrive; we mutate this in place and
	// fire opts.onMeta with the relevant slice each time.
	const meta: StreamCompletionMeta = {};
	const stderrDecoder = new TextDecoder();

	const ndjson = buildNdjsonBuffer(deps.plugin, opts, meta);

	await runSubprocess(
		deps.io,
		{
			binary,
			args,
			cwd,
			env: buildSafeEnv(),
			signal: opts.signal,
			stdinPayload: userPrompt,
		},
		{
			onStdout: (chunk) => ndjson.push(chunk),
			onStderr: (chunk) => logStderrLines(deps.plugin, stderrDecoder, chunk),
			onTerminate: (outcome) => {
				// Flush any trailing partial line BEFORE reading meta —
				// a CLI that exits without a final \n still surfaces its
				// last event. Cleanup runs in every branch (incl. spawn
				// failures) since writeSysPromptFile ran first.
				ndjson.flush();
				void cleanupSysPromptFile(deps.io, sysPromptPath);
				dispatchTerminate(outcome, binary, meta, opts);
			},
			onStdinError: (msg) => {
				deps.plugin.logger.warn(`claude-code stdin error: ${msg}`);
			},
		},
		deps.registerLive,
		deps.unregisterLive,
	);
}

function validateSessionId(raw: string | null, plugin: YunseulPlugin): string | null {
	if (raw === null) return null;
	if (SESSION_ID_PATTERN.test(raw)) return raw;
	plugin.logger.warn('claude-code: refusing invalid claudeCodeSessionId; starting a fresh session');
	return null;
}

function validateModelOverride(raw: string, plugin: YunseulPlugin): string | null {
	if (raw.length === 0) return null;
	if (MODEL_OVERRIDE_PATTERN.test(raw)) return raw;
	plugin.logger.warn(`claude-code: ignoring invalid model override "${raw}"`);
	return null;
}

function buildNdjsonBuffer(
	plugin: YunseulPlugin,
	opts: StreamChatOpts,
	meta: StreamCompletionMeta,
): NdjsonBuffer {
	// Callbacks dereference plugin.logger fresh on each invocation so
	// tests that stub plugin.logger.warn AFTER constructor (e.g. the
	// hazard-path suite at claude-code.test.ts:1011) still see their
	// stub fire. A `const warn = plugin.logger.warn` captured once
	// would miss those later stubs.
	return new NdjsonBuffer({
		onText: (text) => opts.onToken(text),
		onSystemInit: (sid) => {
			meta.sessionId = sid;
			opts.onMeta?.({ sessionId: sid });
		},
		onResult: (event) => {
			if (event.totalCostUsd !== undefined) meta.totalCostUsd = event.totalCostUsd;
			if (event.sessionId !== undefined) meta.sessionId = event.sessionId;
			if (event.inputTokens !== undefined) meta.inputTokens = event.inputTokens;
			if (event.outputTokens !== undefined) meta.outputTokens = event.outputTokens;
			opts.onMeta?.({ ...meta });
		},
		onApiRetry: (attempt) => {
			// Only surface a Notice when the retry count is high enough
			// to matter — a single retry is normal exponential backoff.
			if (attempt !== undefined && attempt > 1) {
				new Notice(`Claude Code: retrying (attempt ${attempt})`);
			}
			plugin.logger.warn(`claude-code api_retry: attempt=${attempt ?? '?'}`);
		},
		warn: (m) => plugin.logger.warn(m),
		debug: (m) => plugin.logger.debug(m),
	});
}

function logStderrLines(
	plugin: YunseulPlugin,
	decoder: TextDecoder,
	chunk: Buffer | string,
): void {
	// Surface each stderr line to the logger gated on warn. We don't
	// promote stderr to an error eagerly — the CLI emits non-fatal
	// warnings here too. Redact common credential patterns before
	// logging.
	const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
	for (const line of text.split('\n')) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		plugin.logger.warn(`claude-code stderr: ${redactSecrets(trimmed)}`);
	}
}
