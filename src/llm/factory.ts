import type YunseulPlugin from '../main';
import { LMClient } from '../lmstudio/client';
import { ClaudeCodeClient } from '../claude-code/client';
import type { LLMClient } from './types';

// Single source of truth for "which backend is wired up right now".
// The settings tab calls `plugin.rebuildLLMClient()` after the
// provider dropdown changes; main.ts uses this factory in onload to
// install the initial client. New providers slot in here and nowhere
// else — the chat session, view, prompt assembler, and persistence
// layer all only see the `LLMClient` interface.

export function makeLLMClient(plugin: YunseulPlugin): LLMClient {
	switch (plugin.settings.provider) {
		case 'claude-code':
			return new ClaudeCodeClient(plugin);
		case 'lm-studio':
		default:
			return new LMClient(() => plugin.settings);
	}
}
