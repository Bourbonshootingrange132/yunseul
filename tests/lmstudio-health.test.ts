import { describe, expect, it } from 'vitest';
import { runHealthCheck } from '../src/lmstudio/health';
import type { LMClient, ProbeResultDetailed } from '../src/lmstudio/client';
import type { YunseulSettings } from '../src/settings';

// runHealthCheck wraps LMClient.probeDetailed() and lifts the result into
// the user-facing message strings. We exercise each branch by stubbing
// probeDetailed to return the four canonical shapes (ok, corsBlocked,
// http-error, offline) and asserting both the state enum and the message.

function makeSettings(): YunseulSettings {
	return {
		schemaVersion: 1,
		provider: 'lm-studio',
		lmStudio: {
			baseUrl: 'http://localhost:1234/v1',
			apiKey: '',
			chatModel: '',
			temperature: 0.7,
			maxContextChars: 12000,
			maxConversationRounds: 10,
		},
		claudeCode: {
			binary: '',
			modelOverride: '',
			enableWrites: false,
		},
		chat: {
			suggestions: [],
			downloadFolder: 'AI Chats',
		},
		index: {
			enabled: false,
			topK: 8,
			excludeTags: [],
			promptState: 'unanswered',
		},
		privacy: {
			allowExternalImages: false,
			treatClippingsAsUntrusted: true,
			clippingsFolder: 'Clippings',
		},
		debug: false,
	};
}

function makeClient(result: ProbeResultDetailed): LMClient {
	return {
		probeDetailed: async (): Promise<ProbeResultDetailed> => result,
	} as unknown as LMClient;
}

describe('runHealthCheck', () => {
	it("maps ok=true to state='ready' with the configured baseUrl in the message", async () => {
		const client = makeClient({ ok: true, corsBlocked: false, status: 200 });
		const out = await runHealthCheck(client, makeSettings);
		expect(out.state).toBe('ready');
		expect(out.corsBlocked).toBe(false);
		expect(out.message).toContain('http://localhost:1234/v1');
	});

	it('maps corsBlocked=true to an actionable LM Studio --cors message', async () => {
		const client = makeClient({
			ok: false,
			corsBlocked: true,
			status: 200,
			error: 'CORS',
		});
		const out = await runHealthCheck(client, makeSettings);
		expect(out.state).toBe('offline');
		expect(out.corsBlocked).toBe(true);
		expect(out.message).toContain('CORS');
		expect(out.message).toContain('lms server start --cors');
	});

	it('maps a numeric status (http-error) into the user message', async () => {
		const client = makeClient({
			ok: false,
			corsBlocked: false,
			status: 401,
			error: 'unauthorized',
		});
		const out = await runHealthCheck(client, makeSettings);
		expect(out.state).toBe('offline');
		expect(out.message).toContain('HTTP 401');
		expect(out.message).toContain('http://localhost:1234/v1');
	});

	it('maps the offline (no status, no CORS flag) case to a generic unreachable message', async () => {
		const client = makeClient({
			ok: false,
			corsBlocked: false,
			error: 'connect ECONNREFUSED',
		});
		const out = await runHealthCheck(client, makeSettings);
		expect(out.state).toBe('offline');
		expect(out.corsBlocked).toBe(false);
		expect(out.message).toContain('unreachable');
	});
});
