import tseslint from 'typescript-eslint';
import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import { globalIgnores } from 'eslint/config';

export default tseslint.config(
	globalIgnores([
		'node_modules',
		'dist',
		'coverage',
		'esbuild.config.mjs',
		'version-bump.mjs',
		'versions.json',
		'main.js',
		'package.json',
		'package-lock.json',
		'tsconfig.json',
		'tests/**',
		'vitest.config.ts',
	]),
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: ['eslint.config.mts', 'manifest.json'],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		// Project-specific overrides applied AFTER the recommended preset so they win.
		rules: {
			'@typescript-eslint/no-unused-vars': ['warn', {
				argsIgnorePattern: '^_',
				varsIgnorePattern: '^_',
				caughtErrorsIgnorePattern: '^_',
			}],
			// Disabled: the rule's case-folder mangles legitimate URLs (http://, /v1/models),
			// API names (requestUrl), acronyms (CORS), and version labels (MVP, V1).
			// Our settings strings are already in sentence case for normal prose.
			'obsidianmd/ui/sentence-case': 'off',
		},
	},
	{
		// LMStudio client needs raw `fetch` for two narrow purposes:
		//   1. streaming SSE — requestUrl returns the whole body at once,
		//      which would defeat token-by-token streaming.
		//   2. probeDetailed — compares fetch (CORS-aware) vs requestUrl
		//      (CORS-bypassing) to distinguish CORS-blocked from offline.
		// Switching to requestUrl in either path would silently break
		// streaming or hide a misconfiguration error users need to fix.
		// Scoped override so per-line eslint-disable comments are not
		// required; the obsidianmd preset's `no-restricted-globals` rule
		// (which forbids `fetch`) is reset here without affecting any
		// other restricted globals (`app`, `localStorage`).
		files: ['src/lmstudio/client.ts'],
		rules: {
			'no-restricted-globals': ['error',
				{
					name: 'app',
					message: 'Avoid using the global app object. Instead use the reference provided by your plugin instance.',
				},
				{
					name: 'localStorage',
					message: 'Prefer `App#saveLocalStorage` / `App#loadLocalStorage` functions to write / read localStorage data that\'s unique to a vault.',
				},
			],
		},
	},
	{
		// settings.ts still calls the deprecated PluginSettingTab#display()
		// as a re-render seam. The replacement getSettingDefinitions API
		// (added in 1.13.0) would require a wholesale rewrite from the
		// imperative DOM-building pattern to a declarative description.
		// Tracked as a future refactor; the override exists so the warning
		// doesn't drown out other lint output.
		files: ['src/settings.ts'],
		rules: {
			'@typescript-eslint/no-deprecated': 'off',
		},
	},
);
