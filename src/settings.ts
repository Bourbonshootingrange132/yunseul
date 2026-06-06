import {
	type App,
	FileSystemAdapter,
	Notice,
	PluginSettingTab,
	Setting,
	type TextComponent,
} from 'obsidian';
import type YunseulPlugin from './main';
import { runHealthCheck } from './lmstudio/health';
import { IndexPromptModal } from './ui/IndexPromptModal';
import { isObject } from './util/guards';

// Settings shape for the plugin. v1 introduces a grouped shape — the
// historical flat layout (every knob hanging off the root object) had
// grown to 20+ fields and become hard to reason about. The groups
// mirror the settings-tab section structure: `lmStudio`, `claudeCode`,
// `chat`, `index`, `privacy`, plus the standalone `provider`
// discriminator and `debug` flag. Defaults are chosen per the plan:
// LM Studio's localhost default for baseUrl, 12k chars for context
// (covers most 7B-class chat windows comfortably), and `AI Chats/`,
// `Clippings/` as Obsidian-friendly folder names.
//
// On load we run `migrateSettings()` against `loadData()`. If the stored
// blob carries `schemaVersion: 1` we accept it verbatim (merging any
// missing nested keys against DEFAULT_SETTINGS so a hand-edited
// data.json that drops a field is healed transparently). Otherwise we
// treat it as v0 (the flat shape shipped pre-migration) and lift each
// field into its new grouped path. Each pick goes through a small
// type-checking helper so a wrong-type stored value (user hand-edits
// temperature to a string "0.7", for example) falls back to the
// default rather than poisoning downstream readers.

export type IndexPromptState = 'unanswered' | 'declined' | 'accepted';

/**
 * Which backend the chat session talks to. `lm-studio` covers the
 * OpenAI-compatible local-server family (LM Studio, Ollama, llama.cpp,
 * vLLM, LocalAI). `claude-code` shells out to the local `claude` CLI
 * and rides on the user's existing Claude Code authentication. New
 * providers slot in here and behind the LLMClient factory.
 */
export type Provider = 'lm-studio' | 'claude-code';

export interface YunseulSettings {
	schemaVersion: 1;
	provider: Provider;
	lmStudio: {
		baseUrl: string;
		apiKey: string;
		chatModel: string;
		temperature: number;
		maxContextChars: number;
		maxConversationRounds: number;
	};
	// Claude Code provider knobs. Empty `binary` falls back to `claude`
	// resolved on PATH. Empty `modelOverride` lets the CLI use its
	// default model for the user's subscription. Writes default to
	// false so the first invocation can't surprise the user with edits.
	claudeCode: {
		binary: string;
		modelOverride: string;
		enableWrites: boolean;
	};
	chat: {
		// Quick-suggestion prompts shown in the empty state's numbered list.
		suggestions: string[];
		downloadFolder: string;
	};
	// Vault search (V1 BM25 retrieval). `enabled` gates whether the chat
	// layer actually queries the retriever on each send; `promptState`
	// remembers the three-way first-run choice ("Index now" /
	// "Skip for now" / "Don't ask again") so we don't nag a user who
	// declined.
	index: {
		enabled: boolean;
		topK: number;
		excludeTags: string[];
		promptState: IndexPromptState;
	};
	privacy: {
		allowExternalImages: boolean;
		treatClippingsAsUntrusted: boolean;
		clippingsFolder: string;
	};
	debug: boolean;
}

const DEFAULT_SUGGESTIONS: readonly string[] = [
	'Summarize this note',
	'Find related notes',
	'Extract action items',
	'Explain like I am new here',
];

export const DEFAULT_SETTINGS: YunseulSettings = {
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
		suggestions: [...DEFAULT_SUGGESTIONS],
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

// ----------------------------------------------------------------------
// Migration & pick helpers
// ----------------------------------------------------------------------

/**
 * Result of running `migrateSettings`. `migrated` is true when the raw
 * input required a shape change (v0 → v1 lift, null/non-object →
 * defaults, or a v1 with a missing nested group that mergeV1Defaults
 * healed). It is false for the v1-identity path where stored data is
 * already a complete v1 shape. The flag exists so `main.ts` can gate
 * the post-migration `saveData` call and avoid a redundant write
 * (and Obsidian-Sync round-trip) on every plugin launch when nothing
 * actually changed.
 */
export interface MigrationResult {
	settings: YunseulSettings;
	migrated: boolean;
}

/**
 * Read `raw` (whatever `Plugin.loadData()` returned — could be a v0 flat
 * object, a v1 grouped object, a partial-edit hybrid, null, or a wholly
 * malformed value) and return a well-formed `YunseulSettings`.
 *
 * Idempotent: feeding a v1 object back through this function returns an
 * equivalent v1 object (any missing nested key is filled from
 * DEFAULT_SETTINGS, so a hand-edited config that dropped, say,
 * `index.topK` heals without erasing the user's other choices).
 *
 * Defensive: each field read goes through a type-checking helper
 * (pickStr/pickNum/pickBool/pickStrArr/pickProvider/pickPromptState) so
 * a wrong-type stored value falls back to the default rather than
 * poisoning downstream readers.
 *
 * Forward-compat: an unknown schemaVersion >= 1 (e.g. a future v2
 * data.json read by this older binary after a plugin downgrade) is
 * treated as v1 — we run `mergeV1Defaults` so we preserve whatever v1-
 * shaped fields exist rather than mis-interpreting a grouped v2 object
 * as a flat v0 shape and silently resetting every field to defaults.
 * The v0 lift only fires when `schemaVersion` is genuinely undefined.
 */
export function migrateSettings(raw: unknown): YunseulSettings {
	return migrateSettingsWithFlag(raw).settings;
}

/**
 * Same as `migrateSettings` but also reports whether the shape changed.
 * Callers that want to avoid a redundant disk write when the stored
 * shape is already canonical (the v1-identity path) should use this and
 * gate their `saveData` call on `migrated === true`.
 */
export function migrateSettingsWithFlag(raw: unknown): MigrationResult {
	// Tighten the guard: arrays are typeof 'object' but cannot carry the
	// nested groups we expect. Treating an array as v0 would silently
	// reset every field — return defaults instead, which is the same
	// net effect but with explicit intent.
	if (!isObject(raw) || Array.isArray(raw)) {
		return { settings: cloneDefaults(), migrated: true };
	}
	const schemaVersion = typeof raw.schemaVersion === 'number' && Number.isFinite(raw.schemaVersion)
		? raw.schemaVersion
		: undefined;

	if (schemaVersion === 1) {
		// v1-identity path: merge defaults into any missing nested groups
		// so a hand-edited data.json that dropped a key is healed, and
		// report whether anything had to be healed so the caller can
		// skip the redundant saveData on a clean v1 round-trip.
		return mergeV1Defaults(raw);
	}

	if (schemaVersion !== undefined && schemaVersion >= 1) {
		// Forward-compat: a future plugin write of schemaVersion=2 (or
		// any value >=1 that this build doesn't recognize) is treated as
		// "at least v1-shaped" — we run the v1 merge so the user's v1
		// fields survive a downgrade. Without this branch, a v2-shaped
		// data.json would fall through to the v0 lift, find none of the
		// flat-shape keys at the root, and silently reset everything to
		// defaults. The v0 lift now only fires for genuine v0 inputs
		// (schemaVersion undefined).
		return mergeV1Defaults(raw);
	}

	// v0 (no schemaVersion): treat raw as the flat shape and lift each
	// field into its new group.
	const v0 = raw;
	// Derive promptState from bm25Enabled for v0 users who never recorded
	// indexPromptState explicitly. A stored `bm25Enabled: true` is
	// evidence that the user accepted the index (the modal flips both
	// fields atomically — you can't have enabled=true without an
	// accepted state), so without this inference a v0 → v1 migration
	// would reset their promptState to 'unanswered' and re-fire the
	// IndexPromptModal on every launch.
	const v0BmEnabled = pickBool(v0.bm25Enabled, DEFAULT_SETTINGS.index.enabled);
	const v0PromptStateRaw = v0.indexPromptState;
	const v0PromptState = (v0PromptStateRaw === undefined && v0BmEnabled)
		? 'accepted' as const
		: pickPromptState(v0PromptStateRaw, DEFAULT_SETTINGS.index.promptState);
	const settings: YunseulSettings = {
		schemaVersion: 1,
		provider: pickProvider(v0.provider, DEFAULT_SETTINGS.provider),
		lmStudio: {
			baseUrl: pickStr(v0.baseUrl, DEFAULT_SETTINGS.lmStudio.baseUrl),
			apiKey: pickStr(v0.apiKey, DEFAULT_SETTINGS.lmStudio.apiKey),
			chatModel: pickStr(v0.chatModel, DEFAULT_SETTINGS.lmStudio.chatModel),
			temperature: pickNum(v0.temperature, DEFAULT_SETTINGS.lmStudio.temperature),
			maxContextChars: pickNum(v0.maxContextChars, DEFAULT_SETTINGS.lmStudio.maxContextChars),
			maxConversationRounds: pickNum(
				v0.maxConversationRounds,
				DEFAULT_SETTINGS.lmStudio.maxConversationRounds,
			),
		},
		claudeCode: {
			binary: pickStr(v0.claudeBinary, DEFAULT_SETTINGS.claudeCode.binary),
			modelOverride: pickStr(v0.claudeModel, DEFAULT_SETTINGS.claudeCode.modelOverride),
			enableWrites: pickBool(v0.claudeCodeEnableWrites, DEFAULT_SETTINGS.claudeCode.enableWrites),
		},
		chat: {
			suggestions: pickStrArr(v0.suggestions, DEFAULT_SETTINGS.chat.suggestions),
			downloadFolder: pickStr(v0.downloadFolder, DEFAULT_SETTINGS.chat.downloadFolder),
		},
		index: {
			enabled: v0BmEnabled,
			topK: pickNum(v0.topK, DEFAULT_SETTINGS.index.topK),
			excludeTags: pickStrArr(v0.excludeTags, DEFAULT_SETTINGS.index.excludeTags),
			promptState: v0PromptState,
		},
		privacy: {
			allowExternalImages: pickBool(
				v0.allowExternalImages,
				DEFAULT_SETTINGS.privacy.allowExternalImages,
			),
			treatClippingsAsUntrusted: pickBool(
				v0.treatClippingsAsUntrusted,
				DEFAULT_SETTINGS.privacy.treatClippingsAsUntrusted,
			),
			clippingsFolder: pickStr(v0.clippingsFolder, DEFAULT_SETTINGS.privacy.clippingsFolder),
		},
		debug: pickBool(v0.debugMode, DEFAULT_SETTINGS.debug),
	};
	// v0 lift is always a migration — the stored shape didn't carry
	// schemaVersion so by definition this is a shape change.
	return { settings, migrated: true };
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
	// `isObject` from util/guards.ts returns true for arrays; here we
	// need to reject arrays because mergeV1Defaults treats each nested
	// group as a plain object with named keys.
	return isObject(x) && !Array.isArray(x);
}

function mergeV1Defaults(raw: Record<string, unknown>): MigrationResult {
	// Track whether the stored v1 shape was already canonical. If every
	// nested group is present with the right type and every scalar value
	// passes its type guard, we can short-circuit `loadSettings`' post-
	// migration `saveData` and avoid a redundant disk write on every
	// plugin launch.
	let migrated = false;
	const mark = (): void => {
		migrated = true;
	};
	const pickSub = (v: unknown): Record<string, unknown> => {
		if (isPlainObject(v)) return v;
		mark();
		return {};
	};
	// String/number/bool pickers wrap the originals and flip the migrated
	// flag when they fell back to the default — so a hand-edited
	// `lmStudio.temperature = "hot"` triggers the resave that heals it.
	const pickStrM = (v: unknown, fb: string): string => {
		if (typeof v === 'string') return v;
		mark();
		return fb;
	};
	const pickNumM = (v: unknown, fb: number): number => {
		if (typeof v === 'number' && Number.isFinite(v)) return v;
		if (typeof v === 'string') {
			const n = Number(v);
			if (Number.isFinite(n)) {
				mark();
				return n;
			}
		}
		mark();
		return fb;
	};
	const pickBoolM = (v: unknown, fb: boolean): boolean => {
		if (typeof v === 'boolean') return v;
		mark();
		return fb;
	};
	const pickStrArrM = (v: unknown, fb: readonly string[]): string[] => {
		if (!Array.isArray(v)) {
			mark();
			return [...fb];
		}
		const out: string[] = [];
		for (const x of v) {
			if (typeof x === 'string') out.push(x);
			else mark();
		}
		return out;
	};
	const pickProviderM = (v: unknown, fb: Provider): Provider => {
		if (v === 'lm-studio' || v === 'claude-code') return v;
		mark();
		return fb;
	};
	const pickPromptStateM = (v: unknown, fb: IndexPromptState): IndexPromptState => {
		if (v === 'unanswered' || v === 'declined' || v === 'accepted') return v;
		mark();
		return fb;
	};
	// schemaVersion must be exactly 1 on a canonical v1 store. If the
	// caller routed a forward-compat value (>=1) into here, that's a
	// migration even though we kept the user's other fields.
	if (raw.schemaVersion !== 1) mark();
	const lmStudio = pickSub(raw.lmStudio);
	const claudeCode = pickSub(raw.claudeCode);
	const chat = pickSub(raw.chat);
	const index = pickSub(raw.index);
	const privacy = pickSub(raw.privacy);
	const settings: YunseulSettings = {
		schemaVersion: 1,
		provider: pickProviderM(raw.provider, DEFAULT_SETTINGS.provider),
		lmStudio: {
			baseUrl: pickStrM(lmStudio.baseUrl, DEFAULT_SETTINGS.lmStudio.baseUrl),
			apiKey: pickStrM(lmStudio.apiKey, DEFAULT_SETTINGS.lmStudio.apiKey),
			chatModel: pickStrM(lmStudio.chatModel, DEFAULT_SETTINGS.lmStudio.chatModel),
			temperature: pickNumM(lmStudio.temperature, DEFAULT_SETTINGS.lmStudio.temperature),
			maxContextChars: pickNumM(
				lmStudio.maxContextChars,
				DEFAULT_SETTINGS.lmStudio.maxContextChars,
			),
			maxConversationRounds: pickNumM(
				lmStudio.maxConversationRounds,
				DEFAULT_SETTINGS.lmStudio.maxConversationRounds,
			),
		},
		claudeCode: {
			binary: pickStrM(claudeCode.binary, DEFAULT_SETTINGS.claudeCode.binary),
			modelOverride: pickStrM(
				claudeCode.modelOverride,
				DEFAULT_SETTINGS.claudeCode.modelOverride,
			),
			enableWrites: pickBoolM(claudeCode.enableWrites, DEFAULT_SETTINGS.claudeCode.enableWrites),
		},
		chat: {
			suggestions: pickStrArrM(chat.suggestions, DEFAULT_SETTINGS.chat.suggestions),
			downloadFolder: pickStrM(chat.downloadFolder, DEFAULT_SETTINGS.chat.downloadFolder),
		},
		index: {
			enabled: pickBoolM(index.enabled, DEFAULT_SETTINGS.index.enabled),
			topK: pickNumM(index.topK, DEFAULT_SETTINGS.index.topK),
			excludeTags: pickStrArrM(index.excludeTags, DEFAULT_SETTINGS.index.excludeTags),
			promptState: pickPromptStateM(index.promptState, DEFAULT_SETTINGS.index.promptState),
		},
		privacy: {
			allowExternalImages: pickBoolM(
				privacy.allowExternalImages,
				DEFAULT_SETTINGS.privacy.allowExternalImages,
			),
			treatClippingsAsUntrusted: pickBoolM(
				privacy.treatClippingsAsUntrusted,
				DEFAULT_SETTINGS.privacy.treatClippingsAsUntrusted,
			),
			clippingsFolder: pickStrM(
				privacy.clippingsFolder,
				DEFAULT_SETTINGS.privacy.clippingsFolder,
			),
		},
		debug: pickBoolM(raw.debug, DEFAULT_SETTINGS.debug),
	};
	return { settings, migrated };
}

function cloneDefaults(): YunseulSettings {
	// Deep clone so callers can mutate the returned object without
	// poisoning DEFAULT_SETTINGS (which is exported and reused).
	return {
		schemaVersion: 1,
		provider: DEFAULT_SETTINGS.provider,
		lmStudio: { ...DEFAULT_SETTINGS.lmStudio },
		claudeCode: { ...DEFAULT_SETTINGS.claudeCode },
		chat: {
			suggestions: [...DEFAULT_SETTINGS.chat.suggestions],
			downloadFolder: DEFAULT_SETTINGS.chat.downloadFolder,
		},
		index: {
			enabled: DEFAULT_SETTINGS.index.enabled,
			topK: DEFAULT_SETTINGS.index.topK,
			excludeTags: [...DEFAULT_SETTINGS.index.excludeTags],
			promptState: DEFAULT_SETTINGS.index.promptState,
		},
		privacy: { ...DEFAULT_SETTINGS.privacy },
		debug: DEFAULT_SETTINGS.debug,
	};
}

function pickStr(v: unknown, fallback: string): string {
	return typeof v === 'string' ? v : fallback;
}

function pickNum(v: unknown, fallback: number): number {
	// Accept already-typed numbers (the common case after a v1 round-trip)
	// or numeric strings (the rare case where a user hand-edits data.json
	// and types a number with quotes). Reject NaN/Infinity — those would
	// silently poison downstream arithmetic.
	if (typeof v === 'number' && Number.isFinite(v)) return v;
	if (typeof v === 'string') {
		const n = Number(v);
		if (Number.isFinite(n)) return n;
	}
	return fallback;
}

function pickBool(v: unknown, fallback: boolean): boolean {
	return typeof v === 'boolean' ? v : fallback;
}

function pickStrArr(v: unknown, fallback: readonly string[]): string[] {
	if (!Array.isArray(v)) return [...fallback];
	// Drop any non-string entries defensively — a single bad element in
	// excludeTags would otherwise crash the retriever's tag-match path.
	const out: string[] = [];
	for (const x of v) {
		if (typeof x === 'string') out.push(x);
	}
	return out;
}

function pickProvider(v: unknown, fallback: Provider): Provider {
	if (v === 'lm-studio' || v === 'claude-code') return v;
	return fallback;
}

function pickPromptState(v: unknown, fallback: IndexPromptState): IndexPromptState {
	if (v === 'unanswered' || v === 'declined' || v === 'accepted') return v;
	return fallback;
}

// ----------------------------------------------------------------------
// Settings tab
// ----------------------------------------------------------------------

export class YunseulSettingTab extends PluginSettingTab {
	private readonly plugin: YunseulPlugin;

	constructor(app: App, plugin: YunseulPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		this.renderCurrentSetupCard(containerEl);

		// ---- Provider section ---------------------------------------------
		// The provider dropdown gates the rest of the connection UI.
		// Flipping the dropdown rebuilds the LLM client and re-renders
		// the tab so provider-specific fields appear/disappear in one
		// atomic action.
		this.heading(containerEl, 'Provider');

		// Claude Code requires a FileSystemAdapter — desktop Obsidian.
		// Probing this here lets us gate the dropdown so a mobile user
		// (somehow on a manifest that dropped isDesktopOnly) doesn't
		// pick claude-code and then see per-message failures.
		const adapter = this.plugin.app.vault.adapter;
		const claudeCodeAvailable = adapter instanceof FileSystemAdapter;

		new Setting(containerEl)
			.setName('LLM provider')
			.setDesc(
				claudeCodeAvailable
					? 'Which backend Yunseul should talk to. LM Studio covers OpenAI-compatible local servers; Claude Code shells out to your local `claude` CLI and rides on its auth.'
					: 'Which backend Yunseul should talk to. Claude Code is disabled because it requires desktop Obsidian.',
			)
			.addDropdown((dropdown) => {
				dropdown.addOption('lm-studio', 'LM Studio (OpenAI-compatible)');
				if (claudeCodeAvailable) {
					dropdown.addOption('claude-code', 'Claude Code (CLI subprocess)');
				}
				dropdown.setValue(this.plugin.settings.provider);
				dropdown.onChange(async (v) => {
					if (v === 'lm-studio' || (v === 'claude-code' && claudeCodeAvailable)) {
						this.plugin.settings.provider = v;
						await this.plugin.saveSettings();
						this.plugin.rebuildLLMClient();
						// Re-render so provider-specific fields appear.
						// `display()` is the documented re-render seam
						// across Obsidian's settings tab examples; the
						// deprecation warning points at the override
						// pattern, not the call.
						// eslint-disable-next-line @typescript-eslint/no-deprecated
						this.display();
					}
				});
			});

		if (this.plugin.settings.provider === 'claude-code') {
			this.renderClaudeCodeSection(containerEl);
		} else {
			this.renderLMStudioSection(containerEl);
		}

		// ---- Chat section -------------------------------------------------
		this.heading(containerEl, 'Chat');

		if (this.plugin.settings.provider === 'lm-studio') {
			// Only LM Studio uses an explicit model id from the chat
			// settings — Claude Code's model selection is controlled
			// either by the CLI's default or by the provider-specific
			// override under the Provider section.
			new Setting(containerEl)
				.setName('Chat model')
				.setDesc('Type the exact model id as it appears in /v1/models.')
				.addText((text) =>
					text
						.setPlaceholder('qwen2.5-7b-instruct')
						.setValue(this.plugin.settings.lmStudio.chatModel)
						.onChange(async (v) => {
							this.plugin.settings.lmStudio.chatModel = v.trim();
							await this.plugin.saveSettings();
						}),
				);
		}

		new Setting(containerEl)
			.setName('Temperature')
			.setDesc('Lower = deterministic, higher = creative. 0.0–2.0.')
			.addText((text) =>
				text
					.setPlaceholder('0.7')
					.setValue(String(this.plugin.settings.lmStudio.temperature))
					.onChange(async (v) => {
						const n = Number.parseFloat(v);
						if (Number.isFinite(n) && n >= 0 && n <= 2) {
							this.plugin.settings.lmStudio.temperature = n;
							await this.plugin.saveSettings();
						} else {
							// Restore last-good value so the user sees
							// their input was rejected.
							text.setValue(String(this.plugin.settings.lmStudio.temperature));
							new Notice('Temperature must be a number between 0 and 2.');
						}
					}),
			);

		new Setting(containerEl)
			.setName('Max context characters')
			.setDesc('Truncates oldest history pairs first. Bound-file excerpt is always kept.')
			.addText((text) =>
				text
					.setPlaceholder('12000')
					.setValue(String(this.plugin.settings.lmStudio.maxContextChars))
					.onChange(async (v) => {
						const n = Number.parseInt(v, 10);
						if (Number.isFinite(n) && n > 0) {
							this.plugin.settings.lmStudio.maxContextChars = n;
							await this.plugin.saveSettings();
						} else {
							text.setValue(String(this.plugin.settings.lmStudio.maxContextChars));
							new Notice('Max context characters must be a positive integer.');
						}
					}),
			);

		new Setting(containerEl)
			.setName('Max conversation rounds')
			.setDesc('Drops oldest turn pairs once this many rounds accumulate. 1–20.')
			.addSlider((slider) =>
				slider
					.setLimits(1, 20, 1)
					.setValue(this.plugin.settings.lmStudio.maxConversationRounds)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.plugin.settings.lmStudio.maxConversationRounds = v;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Download folder')
			.setDesc('Folder for "Download conversation" Markdown files.')
			.addText((text) =>
				text
					.setPlaceholder('AI Chats')
					.setValue(this.plugin.settings.chat.downloadFolder)
					.onChange(async (v) => {
						this.plugin.settings.chat.downloadFolder = v.trim();
						await this.plugin.saveSettings();
					}),
			);

		// ---- Vault search section -----------------------------------------
		this.heading(containerEl, 'Vault search');

		new Setting(containerEl)
			.setName('Enable vault search')
			.setDesc('Index every markdown file so the assistant can find relevant notes for each question (BM25, on-device).')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.index.enabled).onChange(async (v) => {
					const wasEnabled = this.plugin.settings.index.enabled;
					if (v && !wasEnabled && this.plugin.settings.index.promptState !== 'accepted') {
						// First time turning it on (or after a previous decline).
						// Defer the actual save until the modal's button handlers
						// run — otherwise the toggle would persist `index.enabled=true`
						// even if the user closes the modal without picking,
						// leaving the toggle UI and the bootstrap gate
						// (`index.promptState === 'accepted' && index.enabled`)
						// in inconsistent states. Reset the toggle UI for now;
						// the modal will flip both fields atomically.
						toggle.setValue(false);
						new IndexPromptModal(this.app, this.plugin).open();
						return;
					}
					this.plugin.settings.index.enabled = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Top results per query')
			.setDesc('How many vault notes to include as retrieved context per question. 1–20.')
			.addSlider((slider) =>
				slider
					.setLimits(1, 20, 1)
					.setValue(this.plugin.settings.index.topK)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.plugin.settings.index.topK = v;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Exclude tags')
			.setDesc('Comma-separated list of tags. Notes carrying any of these tags are excluded from retrieval. Leading "#" optional.')
			.addText((text) =>
				text
					.setPlaceholder('private, draft')
					.setValue(this.plugin.settings.index.excludeTags.join(', '))
					.onChange(async (v) => {
						this.plugin.settings.index.excludeTags = v
							.split(',')
							.map((s) => s.trim())
							.filter((s) => s.length > 0);
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Force re-index now')
			.setDesc('Rebuilds the vault index from scratch. Useful after a major vault reorganization.')
			.addButton((btn) =>
				btn
					.setButtonText('Re-index')
					.onClick(() => {
						// Call the public plugin method directly. We
						// previously routed through app.commands, which is
						// undocumented and required an `as unknown` cast
						// to satisfy the type system.
						void this.plugin.startVaultIndexBuild('force');
					}),
			);

		new Setting(containerEl)
			.setName('Reset index')
			.setDesc('Removes the index file and disables vault search. Re-enable to rebuild.')
			.addButton((btn) =>
				btn
					.setButtonText('Reset')
					// setDestructive() is the modern API but requires Obsidian 1.13.
					// We target minAppVersion 1.7.2 so we use the deprecated
					// setWarning() form. Lint exemption below.
					// eslint-disable-next-line @typescript-eslint/no-deprecated
					.setWarning()
					.onClick(() => {
						// Surface the confirmation modal rather than
						// destroying the index on a single mis-click.
						this.plugin.promptResetVaultIndex();
					}),
			);

		// ---- Privacy section ----------------------------------------------
		this.heading(containerEl, 'Privacy');

		new Setting(containerEl)
			.setName('Allow external images in chat')
			.setDesc('When off, ![](https://...) is replaced with a placeholder so the renderer cannot fire a request.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.privacy.allowExternalImages).onChange(async (v) => {
					this.plugin.settings.privacy.allowExternalImages = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Treat clippings as untrusted')
			.setDesc('Files in the clippings folder are never auto-included via context collection.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.privacy.treatClippingsAsUntrusted).onChange(async (v) => {
					this.plugin.settings.privacy.treatClippingsAsUntrusted = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Clippings folder')
			.setDesc('Folder treated as untrusted when the toggle above is on.')
			.addText((text) =>
				text
					.setPlaceholder('Clippings')
					.setValue(this.plugin.settings.privacy.clippingsFolder)
					.onChange(async (v) => {
						this.plugin.settings.privacy.clippingsFolder = v.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Debug mode')
			.setDesc('Enables debug logging to the developer console.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.debug).onChange(async (v) => {
					this.plugin.settings.debug = v;
					await this.plugin.saveSettings();
				}),
			);
	}

	/**
	 * LM Studio / OpenAI-compatible server section. Surfaces the base
	 * URL, optional Bearer token, and a two-step health probe button.
	 * Mirrors the pre-provider-split layout 1:1 so existing users see
	 * no UI change when they leave the dropdown on its default.
	 */
	private renderLMStudioSection(containerEl: HTMLElement): void {
		this.heading(containerEl, 'Server');

		new Setting(containerEl)
			.setName('Base URL (OpenAI-compatible)')
			.setDesc('Works with LM Studio, Ollama, llama.cpp server, vLLM, LocalAI.')
			.addText((text) =>
				text
					.setPlaceholder('http://localhost:1234/v1')
					.setValue(this.plugin.settings.lmStudio.baseUrl)
					.onChange(async (v) => {
						this.plugin.settings.lmStudio.baseUrl = v.trim();
						await this.plugin.saveSettings();
					}),
			);

		this.buildApiKeySetting(containerEl);

		let testStatus: HTMLDivElement | null = null;
		new Setting(containerEl)
			.setName('Test connection')
			.setDesc('Pings /v1/models via requestUrl and a streaming fetch to distinguish CORS from server-off.')
			.addButton((btn) =>
				btn
					.setButtonText('Test')
					.onClick(async () => {
						btn.setDisabled(true);
						btn.setButtonText('Testing...');
						const result = await runHealthCheck(this.plugin.getLMStudioClient(), () => this.plugin.settings);
						new Notice(result.message, 6000);
						this.plugin.updateConnectionState({
							state: result.state,
							message: result.message,
							kind: result.corsBlocked ? 'cors-blocked' : undefined,
						});
						if (testStatus !== null) {
							testStatus.setText(`Last result: ${result.message}`);
							testStatus.removeClass('yunseul-status-ok', 'yunseul-status-bad');
							testStatus.addClass(result.state === 'ready' ? 'yunseul-status-ok' : 'yunseul-status-bad');
						}
						btn.setDisabled(false);
						btn.setButtonText('Test');
					}),
			);
		testStatus = containerEl.createDiv({
			cls: 'yunseul-test-status',
			attr: { role: 'status', 'aria-live': 'polite' },
		});
		const initialState = this.plugin.getConnectionState().state;
		if (initialState !== 'unknown') {
			testStatus.setText(`Last result: ${initialState === 'ready' ? 'Connected' : 'Offline'}`);
			testStatus.addClass(initialState === 'ready' ? 'yunseul-status-ok' : 'yunseul-status-bad');
		}
	}

	/**
	 * Claude Code section. Surfaces the binary path override, optional
	 * model override, the writes toggle (with a strong warning), and a
	 * probe button that runs `claude --version` to confirm the CLI is
	 * reachable. Auth lives entirely inside the user's Claude Code
	 * install — we link to the docs rather than handle it here.
	 */
	private renderClaudeCodeSection(containerEl: HTMLElement): void {
		this.heading(containerEl, 'Claude Code');

		new Setting(containerEl)
			.setName('Claude binary path')
			.setDesc('Absolute path to the `claude` executable. Leave blank to use whatever `claude` resolves to on PATH.')
			.addText((text) =>
				text
					.setPlaceholder('claude — falls back to PATH')
					.setValue(this.plugin.settings.claudeCode.binary)
					.onChange(async (v) => {
						this.plugin.settings.claudeCode.binary = v.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Model override')
			.setDesc('Optional. Passed to `claude --model <id>`. Blank uses the CLI default for your subscription.')
			.addText((text) =>
				text
					.setPlaceholder('(use Claude Code\'s default)')
					.setValue(this.plugin.settings.claudeCode.modelOverride)
					.onChange(async (v) => {
						this.plugin.settings.claudeCode.modelOverride = v.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Enable file writes')
			.setDesc('When on, Claude can use Edit and Write tools inside your vault. Off by default — reads/search only.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.claudeCode.enableWrites).onChange(async (v) => {
					this.plugin.settings.claudeCode.enableWrites = v;
					await this.plugin.saveSettings();
					if (v) {
						new Notice(
							'Claude can now modify files in your vault. Disable this in Settings if you do not need it.',
							8000,
						);
					}
				}),
			);

		let cliStatus: HTMLDivElement | null = null;
		new Setting(containerEl)
			.setName('Test connection')
			.setDesc('Runs `claude --version` to confirm the CLI is reachable. Does not check auth.')
			.addButton((btn) =>
				btn
					.setButtonText('Test')
					.onClick(async () => {
						btn.setDisabled(true);
						btn.setButtonText('Testing...');
						try {
							const result = await this.plugin.lmClient.probe();
							new Notice(result.message, 6000);
							// Update the plugin-level connection state so the
							// chat banner reflects reality. We carry kind +
							// message into the envelope so the banner renders
							// provider-aware actionable text (not-found,
							// not-logged-in, etc.) instead of a generic string.
							this.plugin.updateConnectionState({
								state: result.ok ? 'ready' : 'offline',
								message: result.message,
								kind: result.kind,
							});
							if (cliStatus !== null) {
								cliStatus.setText(`Last result: ${result.message}`);
								cliStatus.removeClass('yunseul-status-ok', 'yunseul-status-bad');
								cliStatus.addClass(result.ok ? 'yunseul-status-ok' : 'yunseul-status-bad');
							}
						} finally {
							btn.setDisabled(false);
							btn.setButtonText('Test');
						}
					}),
			);
		cliStatus = containerEl.createDiv({
			cls: 'yunseul-test-status',
			attr: { role: 'status', 'aria-live': 'polite' },
		});
		const initialState = this.plugin.getConnectionState().state;
		if (initialState !== 'unknown') {
			cliStatus.setText(`Last result: ${initialState === 'ready' ? 'CLI reachable' : 'Offline / not found'}`);
			cliStatus.addClass(initialState === 'ready' ? 'yunseul-status-ok' : 'yunseul-status-bad');
		}

		const help = containerEl.createDiv({ cls: 'yunseul-help' });
		help.createEl('span', { text: 'Yunseul uses your existing Claude Code login. See ' });
		help.createEl('a', {
			text: 'authentication docs',
			href: 'https://code.claude.com/docs/en/authentication',
			attr: { target: '_blank', rel: 'noopener noreferrer' },
		});
		help.createEl('span', { text: '.' });
	}

	private buildApiKeySetting(containerEl: HTMLElement): void {
		// The API key is rendered as a password input with a show/hide
		// toggle. We surface a one-shot Notice the first time the user
		// types into it to remind them that data.json is synced as plain
		// JSON if they use Obsidian Sync or git the vault. We also
		// render a persistent inline warning whenever a key is present
		// so users who load existing keys without typing still see it.
		let textRef: TextComponent | null = null;
		let revealed = false;
		let warned = false;

		const setting = new Setting(containerEl)
			.setName('API key (optional)')
			.setDesc('Sent as Authorization: Bearer. Stored in data.json — sync services see plain text.');

		setting.addText((text) => {
			textRef = text;
			text.inputEl.type = 'password';
			text.inputEl.setAttr('autocomplete', 'off');
			text.inputEl.setAttr('spellcheck', 'false');
			text
				.setPlaceholder('sk-... or local-token')
				.setValue(this.plugin.settings.lmStudio.apiKey)
				.onChange(async (v) => {
					if (!warned && v.length > 0) {
						warned = true;
						new Notice(
							'Reminder: this token is stored in plain text in data.json. Sync services can see it.',
							7000,
						);
					}
					this.plugin.settings.lmStudio.apiKey = v;
					await this.plugin.saveSettings();
					syncWarningRow();
				});
		});

		setting.addExtraButton((btn) =>
			btn
				.setIcon('eye')
				.setTooltip('Show/hide token')
				.onClick(() => {
					if (textRef === null) return;
					revealed = !revealed;
					textRef.inputEl.type = revealed ? 'text' : 'password';
					btn.setIcon(revealed ? 'eye-off' : 'eye');
				}),
		);

		// Persistent banner under the API key field. Re-rendered each
		// display() call. aria-live=polite surfaces it to screen readers.
		const warningRow = containerEl.createDiv({
			cls: 'yunseul-warning',
			attr: { role: 'note', 'aria-live': 'polite' },
		});
		warningRow.hide();
		const syncWarningRow = (): void => {
			if (this.plugin.settings.lmStudio.apiKey.length > 0) {
				warningRow.setText(
					'An API token is set. data.json stores it as plain text — sync services (Obsidian Sync, git) will see it.',
				);
				warningRow.show();
			} else {
				warningRow.empty();
				warningRow.hide();
			}
		};
		syncWarningRow();
	}

	/**
	 * Section heading helper. Adds the .yunseul-section-heading class
	 * to the rendered setting element so the CSS divider rule applies.
	 */
	private heading(containerEl: HTMLElement, name: string): void {
		const s = new Setting(containerEl).setName(name).setHeading();
		s.settingEl.addClass('yunseul-section-heading');
	}

	/**
	 * Operator's-Console "Current setup" card. Renders at the top of the
	 * settings tab and shows the active provider, model id, and connection
	 * status — gives the user a single glance summary of where their
	 * messages are routing before they edit any field.
	 */
	private renderCurrentSetupCard(containerEl: HTMLElement): void {
		const card = containerEl.createDiv({ cls: 'yunseul-settings-summary' });

		const labelRow = card.createDiv({ cls: 'yunseul-settings-summary-label' });
		const dotWrap = labelRow.createSpan({
			attr: { role: 'status', 'aria-live': 'polite' },
		});
		const state = this.plugin.getConnectionState().state;
		const dot = dotWrap.createSpan({
			cls: 'yunseul-status-dot',
			attr: { 'aria-hidden': 'true' },
		});
		if (state === 'ready') dot.addClass('is-ready');
		else if (state === 'offline') dot.addClass('is-offline');
		else dot.addClass('is-unknown');
		const srState = state === 'ready'
			? 'Connected'
			: state === 'offline'
				? 'Disconnected'
				: 'Unknown connection';
		dotWrap.createSpan({ cls: 'yunseul-sr-only', text: srState });
		labelRow.createSpan({ text: 'Current setup' });

		const grid = card.createDiv({ cls: 'yunseul-settings-summary-grid' });

		const provCol = grid.createDiv({ cls: 'yunseul-settings-summary-col' });
		provCol.createSpan({ cls: 'yunseul-settings-summary-col-label', text: 'Provider' });
		provCol.createSpan({
			cls: 'yunseul-settings-summary-col-value',
			text: this.plugin.settings.provider,
		});

		const modelCol = grid.createDiv({ cls: 'yunseul-settings-summary-col' });
		modelCol.createSpan({ cls: 'yunseul-settings-summary-col-label', text: 'Model' });
		const modelValue = this.plugin.settings.provider === 'claude-code'
			? (this.plugin.settings.claudeCode.modelOverride.length > 0
				? this.plugin.settings.claudeCode.modelOverride
				: 'claude (default)')
			: (this.plugin.settings.lmStudio.chatModel.length > 0
				? this.plugin.settings.lmStudio.chatModel
				: '(no model)');
		modelCol.createSpan({
			cls: 'yunseul-settings-summary-col-value',
			text: modelValue,
		});
	}
}
