import { describe, expect, it } from 'vitest';
import { makeLLMClient } from '../src/llm/factory';
import { LMClient } from '../src/lmstudio/client';
import { ClaudeCodeClient } from '../src/claude-code/client';
import { FileSystemAdapter } from './_stubs/obsidian';
import type YunseulPlugin from '../src/main';

// Tiny coverage of the provider switch in makeLLMClient. We don't want to
// build a full plugin shim here — the factory only reads
// `settings.provider`, manifest.id, and (for Claude Code) the vault
// adapter. We pass a minimal object cast to `YunseulPlugin` since the
// factory does not exercise the rest of the surface.

function makeStubPlugin(provider: string): YunseulPlugin {
	const stub = {
		settings: { provider, apiKey: '', baseUrl: 'http://x' },
		logger: {
			debug: (): void => {},
			info: (): void => {},
			warn: (): void => {},
			error: (): void => {},
		},
		manifest: { id: 'yunseul' },
		app: {
			vault: {
				adapter: new FileSystemAdapter('/test/vault'),
				configDir: '.obsidian',
			},
		},
	};
	return stub as unknown as YunseulPlugin;
}

describe('makeLLMClient', () => {
	it("returns an LMClient instance when provider='lm-studio'", () => {
		const client = makeLLMClient(makeStubPlugin('lm-studio'));
		expect(client).toBeInstanceOf(LMClient);
	});

	it("returns a ClaudeCodeClient instance when provider='claude-code'", () => {
		const client = makeLLMClient(makeStubPlugin('claude-code'));
		expect(client).toBeInstanceOf(ClaudeCodeClient);
	});

	it('falls back to LMClient for an unknown provider value (defensive default)', () => {
		// e.g. settings file edited by hand to an unsupported provider.
		const client = makeLLMClient(makeStubPlugin('some-future-provider'));
		expect(client).toBeInstanceOf(LMClient);
	});
});
