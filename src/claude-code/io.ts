// IO contract for the Claude Code subprocess client. Kept in its own
// leaf module (no node/obsidian imports beyond the structural
// ChildProcess type) so every other claude-code submodule (streamChat,
// sysprompt, lifecycle, probe) can reference the shared shape without
// importing through the orchestrator (client.ts). This breaks the
// source-level type-only cycle between client.ts and streamChat.ts that
// the audit flagged: streamChat.ts now imports `ClaudeCodeIO` from this
// leaf, not from client.ts.
//
// We keep DEFAULT_IO inside client.ts because it pulls in node's
// `child_process` and `fs/promises` and we want the IO definition to
// remain importable from test contexts that stub the bindings.

import type { ChildProcess } from 'child_process';

/**
 * IO surface the Claude Code provider uses to drive a subprocess. The
 * client owns the real implementation (DEFAULT_IO in client.ts) that
 * shells out to node's `child_process` + `fs/promises`. Tests inject a
 * mock variant via the ClaudeCodeClient constructor so they can drive
 * the lifecycle deterministically.
 *
 * Each method intentionally matches its node equivalent's signature so
 * the default implementation is a thin pass-through:
 *   spawn:     child_process.spawn(cmd, args, { cwd, env })
 *   writeFile: fs.promises.writeFile(path, data, { encoding, flag })
 *   unlink:    fs.promises.unlink(path)
 *   mkdir:     fs.promises.mkdir(path, { recursive })
 */
export interface ClaudeCodeIO {
	spawn: (cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcess;
	writeFile: (path: string, data: string) => Promise<void>;
	unlink: (path: string) => Promise<void>;
	mkdir: (path: string, opts: { recursive: boolean }) => Promise<void>;
}
