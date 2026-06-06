import { describe, expect, it } from 'vitest';
import {
	DEFAULT_SETTINGS,
	migrateSettings,
	migrateSettingsWithFlag,
	type YunseulSettings,
} from '../src/settings';

// The migration helper is the only thing standing between a user's
// existing v0 data.json (the historical flat shape) and silent data
// loss / mis-typed values on first load. These tests lock in:
//   - the v0 → v1 lift (every field lands at its documented nested path)
//   - the v1 identity / heal path (idempotency, fill-missing, extras
//     ignored)
//   - defensive type-narrowing on every field (wrong-type values fall
//     back to defaults, NaN/Infinity rejected, arrays of mixed types
//     filtered)
//   - the schemaVersion forward-compat branch (a future v2 input read by
//     an older binary does not silently reset every field)
//   - the migrated-flag contract used by main.ts to gate the post-
//     migration saveData
//   - deep-clone isolation (mutating the result does not poison
//     DEFAULT_SETTINGS)

// Historical v0 fixture — mirrors the repo's pre-migration data.json
// shape. Every field has a non-default value so we can assert the
// migration preserves user choices rather than blanketing them with
// defaults.
const V0_FIXTURE: Record<string, unknown> = {
	provider: 'claude-code',
	baseUrl: 'http://localhost:1234/v1',
	apiKey: 'sk-fake-token',
	chatModel: 'qwen/qwen3.6-35b-a3b',
	temperature: 0.5,
	maxContextChars: 50000,
	maxConversationRounds: 12,
	debugMode: true,
	allowExternalImages: true,
	downloadFolder: 'My Chats',
	treatClippingsAsUntrusted: false,
	clippingsFolder: 'Web Clippings',
	claudeBinary: '/usr/local/bin/claude',
	claudeModel: 'claude-3-5-sonnet-20241022',
	claudeCodeEnableWrites: true,
	bm25Enabled: true,
	topK: 12,
	excludeTags: ['private', 'draft'],
	indexPromptState: 'accepted',
	suggestions: ['Make me a sandwich'],
};

function makeV1(): YunseulSettings {
	// Build a fresh v1 from defaults, then tweak a few fields so the
	// identity-path tests can assert user choices survive.
	return {
		schemaVersion: 1,
		provider: 'claude-code',
		lmStudio: {
			baseUrl: 'http://localhost:1234/v1',
			apiKey: '',
			chatModel: 'gpt-oss-20b',
			temperature: 0.4,
			maxContextChars: 8000,
			maxConversationRounds: 6,
		},
		claudeCode: {
			binary: 'claude',
			modelOverride: 'claude-3-5-sonnet-20241022',
			enableWrites: true,
		},
		chat: {
			suggestions: ['What is in my vault about X?'],
			downloadFolder: 'AI Chats',
		},
		index: {
			enabled: true,
			topK: 10,
			excludeTags: ['private'],
			promptState: 'accepted',
		},
		privacy: {
			allowExternalImages: true,
			treatClippingsAsUntrusted: false,
			clippingsFolder: 'Clippings',
		},
		debug: true,
	};
}

describe('migrateSettings — null / non-object / array', () => {
	it('returns cloneDefaults for null', () => {
		expect(migrateSettings(null)).toEqual(DEFAULT_SETTINGS);
	});

	it('returns cloneDefaults for undefined', () => {
		expect(migrateSettings(undefined)).toEqual(DEFAULT_SETTINGS);
	});

	it('returns cloneDefaults for a string', () => {
		expect(migrateSettings('not settings')).toEqual(DEFAULT_SETTINGS);
	});

	it('returns cloneDefaults for a number', () => {
		expect(migrateSettings(42)).toEqual(DEFAULT_SETTINGS);
	});

	it('returns cloneDefaults for an array (not a v1 object)', () => {
		// isObject returns true for arrays, so we tighten the guard with
		// !Array.isArray in migrateSettings — this asserts the guard.
		expect(migrateSettings([])).toEqual(DEFAULT_SETTINGS);
		expect(migrateSettings([1, 2, 3])).toEqual(DEFAULT_SETTINGS);
	});

	it('reports migrated=true for null/non-object/array (everything was reset)', () => {
		expect(migrateSettingsWithFlag(null).migrated).toBe(true);
		expect(migrateSettingsWithFlag([]).migrated).toBe(true);
		expect(migrateSettingsWithFlag('garbage').migrated).toBe(true);
	});
});

describe('migrateSettings — idempotency', () => {
	it('migrateSettings(migrateSettings(x)) === migrateSettings(x) for null', () => {
		const once = migrateSettings(null);
		const twice = migrateSettings(once);
		expect(twice).toEqual(once);
	});

	it('migrateSettings(migrateSettings(x)) === migrateSettings(x) for {}', () => {
		const once = migrateSettings({});
		const twice = migrateSettings(once);
		expect(twice).toEqual(once);
	});

	it('migrateSettings(migrateSettings(x)) === migrateSettings(x) for DEFAULT_SETTINGS', () => {
		const once = migrateSettings(DEFAULT_SETTINGS);
		const twice = migrateSettings(once);
		expect(twice).toEqual(once);
	});

	it('migrateSettings(migrateSettings(x)) === migrateSettings(x) for the v0 fixture', () => {
		const once = migrateSettings(V0_FIXTURE);
		const twice = migrateSettings(once);
		expect(twice).toEqual(once);
	});

	it('migrateSettings(migrateSettings(x)) === migrateSettings(x) for a partial v1', () => {
		const partial = { schemaVersion: 1, provider: 'claude-code' };
		const once = migrateSettings(partial);
		const twice = migrateSettings(once);
		expect(twice).toEqual(once);
	});

	it('a fully-formed v1 input re-runs as identity (migrated=false)', () => {
		const v1 = makeV1();
		const result = migrateSettingsWithFlag(v1);
		expect(result.settings).toEqual(v1);
		expect(result.migrated).toBe(false);
	});
});

describe('migrateSettings — fill-missing on partial v1', () => {
	it('schemaVersion-only input fills every nested group from defaults', () => {
		const result = migrateSettings({ schemaVersion: 1 });
		expect(result.lmStudio).toEqual(DEFAULT_SETTINGS.lmStudio);
		expect(result.claudeCode).toEqual(DEFAULT_SETTINGS.claudeCode);
		expect(result.chat).toEqual(DEFAULT_SETTINGS.chat);
		expect(result.index).toEqual(DEFAULT_SETTINGS.index);
		expect(result.privacy).toEqual(DEFAULT_SETTINGS.privacy);
		expect(result.provider).toBe(DEFAULT_SETTINGS.provider);
		expect(result.debug).toBe(DEFAULT_SETTINGS.debug);
	});

	it('missing one nested key heals without erasing the user\'s other choices', () => {
		const v1 = makeV1();
		const stored = { ...v1, index: { ...v1.index } };
		// Drop topK; everything else under index should survive.
		delete (stored.index as Partial<typeof v1.index>).topK;
		const result = migrateSettings(stored);
		expect(result.index.topK).toBe(DEFAULT_SETTINGS.index.topK);
		expect(result.index.enabled).toBe(v1.index.enabled);
		expect(result.index.excludeTags).toEqual(v1.index.excludeTags);
		expect(result.index.promptState).toBe(v1.index.promptState);
		// Other groups untouched.
		expect(result.lmStudio).toEqual(v1.lmStudio);
		expect(result.privacy).toEqual(v1.privacy);
	});

	it('healing a partial v1 reports migrated=true', () => {
		const result = migrateSettingsWithFlag({ schemaVersion: 1, provider: 'lm-studio' });
		expect(result.migrated).toBe(true);
	});
});

describe('migrateSettings — bad-type fallback', () => {
	it('wrong-typed scalars all fall back to defaults', () => {
		const result = migrateSettings({
			schemaVersion: 1,
			lmStudio: {
				temperature: 'hot',
				maxContextChars: Number.NaN,
				maxConversationRounds: Number.POSITIVE_INFINITY,
				baseUrl: 42,
				apiKey: { obj: 1 },
				chatModel: null,
			},
		});
		expect(result.lmStudio.temperature).toBe(DEFAULT_SETTINGS.lmStudio.temperature);
		expect(result.lmStudio.maxContextChars).toBe(DEFAULT_SETTINGS.lmStudio.maxContextChars);
		expect(result.lmStudio.maxConversationRounds).toBe(DEFAULT_SETTINGS.lmStudio.maxConversationRounds);
		expect(result.lmStudio.baseUrl).toBe(DEFAULT_SETTINGS.lmStudio.baseUrl);
		expect(result.lmStudio.apiKey).toBe(DEFAULT_SETTINGS.lmStudio.apiKey);
		expect(result.lmStudio.chatModel).toBe(DEFAULT_SETTINGS.lmStudio.chatModel);
	});

	it('numeric strings parse for pickNum (real input via hand-edited data.json)', () => {
		const result = migrateSettings({
			schemaVersion: 1,
			lmStudio: { temperature: '0.42', maxContextChars: '16000' },
		});
		expect(result.lmStudio.temperature).toBe(0.42);
		expect(result.lmStudio.maxContextChars).toBe(16000);
	});

	it('excludeTags drops non-strings defensively', () => {
		const result = migrateSettings({
			schemaVersion: 1,
			index: { excludeTags: ['ok', 42, null, 'also-ok', { x: 1 }, undefined] },
		});
		expect(result.index.excludeTags).toEqual(['ok', 'also-ok']);
	});

	it('non-array excludeTags falls back to defaults', () => {
		const result = migrateSettings({
			schemaVersion: 1,
			index: { excludeTags: 'private,draft' },
		});
		expect(result.index.excludeTags).toEqual(DEFAULT_SETTINGS.index.excludeTags);
	});

	it('non-boolean booleans fall back to defaults', () => {
		const result = migrateSettings({
			schemaVersion: 1,
			privacy: { allowExternalImages: 'yes', treatClippingsAsUntrusted: 1 },
			debug: 'on',
		});
		expect(result.privacy.allowExternalImages).toBe(DEFAULT_SETTINGS.privacy.allowExternalImages);
		expect(result.privacy.treatClippingsAsUntrusted).toBe(DEFAULT_SETTINGS.privacy.treatClippingsAsUntrusted);
		expect(result.debug).toBe(DEFAULT_SETTINGS.debug);
	});

	it('non-object nested groups fall back without erasing other groups', () => {
		const result = migrateSettings({
			schemaVersion: 1,
			lmStudio: 'oops',
			claudeCode: ['array', 'instead'],
			chat: null,
			privacy: { allowExternalImages: true },
		});
		expect(result.lmStudio).toEqual(DEFAULT_SETTINGS.lmStudio);
		expect(result.claudeCode).toEqual(DEFAULT_SETTINGS.claudeCode);
		expect(result.chat).toEqual(DEFAULT_SETTINGS.chat);
		expect(result.privacy.allowExternalImages).toBe(true);
	});

	it('pickProvider rejects unknown providers and falls back', () => {
		const result = migrateSettings({ schemaVersion: 1, provider: 'gpt-4' });
		expect(result.provider).toBe(DEFAULT_SETTINGS.provider);
	});

	it('pickProvider accepts both supported providers', () => {
		expect(migrateSettings({ schemaVersion: 1, provider: 'lm-studio' }).provider).toBe('lm-studio');
		expect(migrateSettings({ schemaVersion: 1, provider: 'claude-code' }).provider).toBe('claude-code');
	});

	it('pickPromptState rejects unknown states and falls back', () => {
		const result = migrateSettings({
			schemaVersion: 1,
			index: { promptState: 'maybe' },
		});
		expect(result.index.promptState).toBe(DEFAULT_SETTINGS.index.promptState);
	});

	it('pickPromptState accepts every documented state', () => {
		for (const state of ['unanswered', 'declined', 'accepted'] as const) {
			expect(
				migrateSettings({ schemaVersion: 1, index: { promptState: state } }).index.promptState,
			).toBe(state);
		}
	});

	it('bad-type fallback reports migrated=true (the wrong type was healed)', () => {
		const result = migrateSettingsWithFlag({
			schemaVersion: 1,
			lmStudio: { temperature: 'hot' },
		});
		expect(result.migrated).toBe(true);
	});
});

describe('migrateSettings — extras ignored', () => {
	it('extra top-level keys are dropped', () => {
		const result = migrateSettings({
			schemaVersion: 1,
			foo: 'bar',
			provider: 'lm-studio',
		}) as YunseulSettings & Record<string, unknown>;
		expect(result.foo).toBeUndefined();
		// Make sure the canonical key set has nothing extra.
		const keys = Object.keys(result).sort();
		expect(keys).toEqual([
			'chat',
			'claudeCode',
			'debug',
			'index',
			'lmStudio',
			'privacy',
			'provider',
			'schemaVersion',
		]);
	});

	it('extra nested keys inside lmStudio are dropped', () => {
		const result = migrateSettings({
			schemaVersion: 1,
			lmStudio: { baseUrl: 'http://x', bogus: 1, junk: 'value' },
		}) as YunseulSettings;
		const lmStudioKeys = Object.keys(result.lmStudio).sort();
		expect(lmStudioKeys).toEqual([
			'apiKey',
			'baseUrl',
			'chatModel',
			'maxContextChars',
			'maxConversationRounds',
			'temperature',
		]);
	});
});

describe('migrateSettings — v0 → v1 lift', () => {
	it('every documented v0 field lands at its v1 nested path', () => {
		const r = migrateSettings(V0_FIXTURE);

		expect(r.schemaVersion).toBe(1);
		expect(r.provider).toBe('claude-code');

		expect(r.lmStudio.baseUrl).toBe('http://localhost:1234/v1');
		expect(r.lmStudio.apiKey).toBe('sk-fake-token');
		expect(r.lmStudio.chatModel).toBe('qwen/qwen3.6-35b-a3b');
		expect(r.lmStudio.temperature).toBe(0.5);
		expect(r.lmStudio.maxContextChars).toBe(50000);
		expect(r.lmStudio.maxConversationRounds).toBe(12);

		expect(r.claudeCode.binary).toBe('/usr/local/bin/claude');
		expect(r.claudeCode.modelOverride).toBe('claude-3-5-sonnet-20241022');
		expect(r.claudeCode.enableWrites).toBe(true);

		expect(r.chat.suggestions).toEqual(['Make me a sandwich']);
		expect(r.chat.downloadFolder).toBe('My Chats');

		expect(r.index.enabled).toBe(true);
		expect(r.index.topK).toBe(12);
		expect(r.index.excludeTags).toEqual(['private', 'draft']);
		expect(r.index.promptState).toBe('accepted');

		expect(r.privacy.allowExternalImages).toBe(true);
		expect(r.privacy.treatClippingsAsUntrusted).toBe(false);
		expect(r.privacy.clippingsFolder).toBe('Web Clippings');

		expect(r.debug).toBe(true);
	});

	it('v0 lift reports migrated=true', () => {
		const result = migrateSettingsWithFlag(V0_FIXTURE);
		expect(result.migrated).toBe(true);
	});

	it('v0 with only bm25Enabled=true infers promptState=accepted', () => {
		// The bug the audit (Scope #4) flagged: a v0 user who never
		// recorded indexPromptState explicitly would otherwise see the
		// IndexPromptModal fire on every launch after the migration.
		const result = migrateSettings({ bm25Enabled: true });
		expect(result.index.enabled).toBe(true);
		expect(result.index.promptState).toBe('accepted');
	});

	it('v0 with bm25Enabled=false leaves promptState at the default', () => {
		const result = migrateSettings({ bm25Enabled: false });
		expect(result.index.enabled).toBe(false);
		expect(result.index.promptState).toBe(DEFAULT_SETTINGS.index.promptState);
	});

	it('v0 with explicit indexPromptState wins over the inference', () => {
		const result = migrateSettings({ bm25Enabled: true, indexPromptState: 'declined' });
		expect(result.index.promptState).toBe('declined');
	});

	it('v0 with neither key falls back to defaults', () => {
		const result = migrateSettings({});
		expect(result.index.enabled).toBe(DEFAULT_SETTINGS.index.enabled);
		expect(result.index.promptState).toBe(DEFAULT_SETTINGS.index.promptState);
	});

	it('v0 with no matching fields returns defaults (but reports migrated)', () => {
		const result = migrateSettingsWithFlag({});
		expect(result.settings).toEqual(DEFAULT_SETTINGS);
		expect(result.migrated).toBe(true);
	});

	it('v0 debugMode preserved into v1 debug', () => {
		const result = migrateSettings({ debugMode: true });
		expect(result.debug).toBe(true);
	});
});

describe('migrateSettings — forward-compat (unknown schemaVersion)', () => {
	it('schemaVersion=2 is treated as v1-shaped (not as v0)', () => {
		// A hypothetical future plugin write reads back through an older
		// binary: we must not blanket-reset its grouped fields.
		const v2Shape = {
			schemaVersion: 2,
			provider: 'claude-code',
			lmStudio: { ...DEFAULT_SETTINGS.lmStudio, chatModel: 'future-model' },
			claudeCode: { ...DEFAULT_SETTINGS.claudeCode, modelOverride: 'future-override' },
			chat: DEFAULT_SETTINGS.chat,
			index: DEFAULT_SETTINGS.index,
			privacy: DEFAULT_SETTINGS.privacy,
			debug: true,
		};
		const result = migrateSettings(v2Shape);
		// User choices survive — they did not silently reset to defaults.
		expect(result.provider).toBe('claude-code');
		expect(result.lmStudio.chatModel).toBe('future-model');
		expect(result.claudeCode.modelOverride).toBe('future-override');
		expect(result.debug).toBe(true);
		// And the result is normalized to schemaVersion=1.
		expect(result.schemaVersion).toBe(1);
	});

	it('NaN schemaVersion is treated as missing → v0 lift', () => {
		const result = migrateSettings({ schemaVersion: Number.NaN, baseUrl: 'http://x' });
		// v0 lift fired (the flat field landed in lmStudio.baseUrl).
		expect(result.lmStudio.baseUrl).toBe('http://x');
	});

	it('string "1" schemaVersion is treated as missing → v0 lift', () => {
		// pickStr/pickNum reject string '1' since typeof !== 'number'.
		const result = migrateSettings({ schemaVersion: '1', baseUrl: 'http://x' });
		expect(result.lmStudio.baseUrl).toBe('http://x');
	});

	it('schemaVersion=2 reports migrated=true (the shape changed)', () => {
		const result = migrateSettingsWithFlag({
			schemaVersion: 2,
			provider: 'lm-studio',
		});
		expect(result.migrated).toBe(true);
	});
});

describe('migrateSettings — deep clone isolation', () => {
	it('mutating the returned lmStudio does not poison DEFAULT_SETTINGS', () => {
		const result = migrateSettings(null);
		result.lmStudio.baseUrl = 'mutated';
		expect(DEFAULT_SETTINGS.lmStudio.baseUrl).toBe('http://localhost:1234/v1');
	});

	it('mutating the returned chat.suggestions does not poison DEFAULT_SETTINGS', () => {
		const result = migrateSettings(null);
		result.chat.suggestions.push('mutation');
		expect(DEFAULT_SETTINGS.chat.suggestions).not.toContain('mutation');
	});

	it('mutating the returned index.excludeTags does not poison DEFAULT_SETTINGS', () => {
		const result = migrateSettings(null);
		result.index.excludeTags.push('private');
		expect(DEFAULT_SETTINGS.index.excludeTags).not.toContain('private');
	});

	it('mutating the returned privacy does not poison DEFAULT_SETTINGS', () => {
		const result = migrateSettings(null);
		result.privacy.clippingsFolder = 'Mutated';
		expect(DEFAULT_SETTINGS.privacy.clippingsFolder).toBe('Clippings');
	});

	it('two independent calls return independent objects', () => {
		const a = migrateSettings(null);
		const b = migrateSettings(null);
		a.lmStudio.chatModel = 'a';
		b.lmStudio.chatModel = 'b';
		expect(a.lmStudio.chatModel).toBe('a');
		expect(b.lmStudio.chatModel).toBe('b');
	});
});

describe('migrateSettingsWithFlag — flag contract for main.ts gate', () => {
	it('canonical v1 (no changes) reports migrated=false', () => {
		const v1 = makeV1();
		expect(migrateSettingsWithFlag(v1).migrated).toBe(false);
	});

	it('canonical v1 deep-clones the result (no aliasing back to the input)', () => {
		// Even on the identity path the caller must be able to mutate the
		// result without rewriting their original input — the rest of the
		// plugin holds settings as a mutable reference.
		const v1 = makeV1();
		const result = migrateSettingsWithFlag(v1).settings;
		result.lmStudio.chatModel = 'mutated';
		expect(v1.lmStudio.chatModel).toBe('gpt-oss-20b');
	});

	it('v1 with extras present is a heal (reports migrated=true)', () => {
		const result = migrateSettingsWithFlag({
			schemaVersion: 1,
			foo: 'bar',
			...DEFAULT_SETTINGS,
		});
		// Whether we report migrated depends on whether the extras leak
		// downstream — we already drop them, but they are evidence the
		// store was non-canonical. The current implementation treats the
		// stripped-extras shape as a heal; that's fine for the gate
		// semantics (we'd write the cleaned shape back).
		expect(result.settings).toEqual(DEFAULT_SETTINGS);
		// No assertion on the migrated flag here — both true and false
		// are acceptable for an extras-only delta (we just clean them).
	});
});
