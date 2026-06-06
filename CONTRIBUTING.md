# Contributing to Yunseul

Thank you for your interest in Yunseul. This file is the developer onboarding guide. End-user docs live in [README.md](README.md).

## Repo layout

```
yunseul/
  manifest.json          # plugin id, version, minAppVersion
  versions.json          # version → minAppVersion map (must agree with manifest)
  package.json           # npm scripts, dev deps
  esbuild.config.mjs     # bundler config
  tsconfig.json          # strict mode
  vitest.config.ts       # test runner + coverage
  eslint.config.mts      # lint config (typed lint via projectService)
  styles.css             # plugin CSS (Operator's Console design tokens)
  src/
    main.ts              # plugin lifecycle, sessions map, command registration
    settings.ts          # YunseulSettings shape, migrateSettings, SettingTab
    chat/                # provider-agnostic chat layer (session, prompt, persist, sanitize)
    llm/                 # provider abstraction (LLMClient interface, factory)
    lmstudio/            # OpenAI-compatible HTTP/SSE client
    claude-code/         # subprocess client (env, ndjson, lifecycle, probe, sysprompt, …)
    index/               # BM25 inverted index + retriever
    ui/                  # AIChatView orchestrator + extracted modules
    util/                # shared helpers (guards, paths, log, throttle, redact)
  tests/                 # vitest suites with the obsidian module stubbed under tests/_stubs/
```

## Dev setup

Prereqs: Node.js 18+ and npm. (We do not pin a package manager other than that the lockfile is npm's.)

```bash
git clone https://github.com/zaemyung/yunseul.git
cd yunseul
npm install
npm run dev            # esbuild in watch mode; writes main.js on every save
```

### Live testing inside Obsidian

The fastest loop is to symlink the repo into a test vault's plugin folder:

```bash
TEST_VAULT="$HOME/Obsidian/TestVault"
mkdir -p "$TEST_VAULT/.obsidian/plugins"
ln -s "$PWD" "$TEST_VAULT/.obsidian/plugins/yunseul"
```

In Obsidian: **Settings → Community plugins → Restricted mode OFF → toggle Yunseul on**. The repo ships a `.hotreload` marker file, so if you install the [Hot Reload](https://github.com/pjeby/hot-reload) community plugin, edits to `main.js` reload Yunseul automatically while `npm run dev` is running. Without Hot Reload, run **Reload app without saving** from the command palette (Cmd/Ctrl-P) after each build.

To exercise the Claude Code backend you need the `claude` CLI installed and authenticated:

```bash
claude --version
claude /status
```

To exercise the LM Studio backend, start a server:

```bash
~/.lmstudio/bin/lms bootstrap        # one-time
lms server start --cors --port 1234
lms get qwen2.5-7b-instruct
lms load qwen2.5-7b-instruct
```

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | esbuild watch — rebuild `main.js` on every save |
| `npm run build` | type-check (`tsc -noEmit -skipLibCheck`) then production esbuild |
| `npm test` | run the full vitest suite once |
| `npm run test:watch` | vitest watch mode |
| `npm run coverage` | vitest with v8 coverage report (writes to `coverage/`) |
| `npm run lint` | ESLint with `eslint-plugin-obsidianmd` rules |

PRs must keep all three of `npm run build`, `npm test`, and `npm run lint` green. CI runs the same three.

## Code conventions

Yunseul enforces a strict set of conventions, most of them via `eslint.config.mts` plus `eslint-plugin-obsidianmd`. The short version:

- **No `any`** — use `unknown` plus a narrowing validator. See `src/util/guards.ts` for the `isObject` pattern.
- **No `var`** — `const` by default, `let` only when reassignment is necessary.
- **No `innerHTML` and no `addEventListener`** — use `createEl()`/`createDiv()`/`setText()` for plugin-controlled DOM, and `MarkdownRenderer.render(...)` for rendered markdown. All event listeners go through `this.registerEvent()`, `this.registerDomEvent()`, or `this.registerInterval()` so they are torn down when the plugin unloads.
- **All icons via `setIcon()`** — never inline SVG strings.
- **All path construction through `normalizePath()`** — `src/util/paths.ts` wraps it for our common operations.
- **In shipped code, only `console.warn` and `console.error` are allowed at direct call sites** — always inside catch blocks that also surface a `Notice`. Debug-mode logging goes through `src/util/log.ts` (which calls `console.debug` internally), gated on `settings.debug`. Lint allows `warn`, `error`, and `debug` via `obsidianmd/rule-custom-message`; the stricter "no direct `console.debug`" rule is a project convention.
- **No secrets in error messages or logs** — use `redactSecrets()` from `src/util/redact.ts` before any `console.warn` / `Notice` that may contain a header, body, or stdout/stderr.

The vitest suites under `tests/` exercise the same code from a JSDOM environment with the `obsidian` module stubbed via `tests/_stubs/obsidian.ts`. New tests should import from `tests/_stubs/obsidian` rather than the real package — see existing suites for the pattern.

## Architecture overview

### Provider abstraction (LLMClient)

The chat layer only ever sees `LLMClient` from `src/llm/types.ts` — a narrow three-method interface (`listModels`, `streamChat`, `probe`). Today's two implementations are `LMClient` (`src/lmstudio/client.ts`, plain `fetch` + an inline SSE parser) and `ClaudeCodeClient` (`src/claude-code/client.ts`, orchestrator over env/lifecycle/ndjson/probe/sysprompt modules). `src/llm/factory.ts` picks one based on `settings.provider`; the chat session, view, prompt assembler, and persistence layer never look at the discriminator themselves.

### Settings (schemaVersion + grouped shape + migration)

`YunseulSettings` (declared in `src/settings.ts`) carries `schemaVersion: 1` and groups every knob into one of five sub-objects: `lmStudio`, `claudeCode`, `chat`, `index`, `privacy`. The grouped layout is the post-v1 shape; pre-v1 stores were a flat object with 20+ root keys. `migrateSettings(raw)` is the single load-time function that accepts either shape, defensively type-checks each pick, and fills missing fields with `DEFAULT_SETTINGS`. `main.ts` calls it once in `onload`, then immediately persists the migrated blob so the next launch reads v1 directly.

### BM25 retrieval

`src/index/bm25.ts` is a self-contained inverted index with title × 3 / heading × 2 / tags × 2 / body × 1 field weights and a small English stopword list. `src/index/retriever.ts` owns the on-disk persistence (sharded JSON under `<vault>/.yunseul/bm25-index.json`, atomic write-then-rename) and surfaces the top-K query API to the chat layer. The session calls the retriever before building the prompt; retrieved chunks are wrapped in `<vault_excerpt path="…" hash="…">…</vault_excerpt>` boundary tags by the prompt assembler in `src/chat/prompt.ts`. `main.ts` wires the incremental `metadataCache.on('changed', …)` debounced re-index.

### UI module boundary

`src/ui/AIChatView.ts` is the `ItemView` orchestrator and is intentionally thin — lifecycle, click delegation, history replay, send orchestration. The substantive UI work lives in extracted modules:

- `ChatHeader.ts` — wordmark, status strip, Copy all / Download / New chat buttons.
- `ChatComposer.ts` — textarea, send/stop morph button, slash hint, bound-file pill.
- `EmptyState.ts` — tagline + quick-start chips.
- `SourcesBlock.ts` — "Top retrieved sources" collapsible with stable keying.
- `ChatExporter.ts` — `sessionToMarkdown`, copy-all, download-conversation.
- `SendController.ts` — per-send streaming pipeline (user + assistant bubbles, throttled `updateContent`, onComplete / onError fan-out).
- `AppendFlow.ts` — `handleAppend` → `AppendPreviewModal` wiring.

`MessageBubble.ts` does the two-phase render: plain-text updates at ~30 fps during stream, full `MarkdownRenderer.render` on `isFinal`. Per-modal classes (`AppendPreviewModal`, `IndexPromptModal`, `ResetIndexConfirmModal`) follow the shared Operator's Console accent tokens defined in `styles.css`.

## How to add a provider

1. Create a new module under `src/<provider>/` exposing a class that implements `LLMClient` from `src/llm/types.ts`. The three methods are `listModels(): Promise<string[]>`, `streamChat(opts: StreamChatOpts): Promise<void>` (must invoke `onToken`, `onComplete`, `onError`, optionally `onMeta`), and `probe(): Promise<ProbeResult>`.
2. Add a discriminator value to the `Provider` union in `src/settings.ts` and an entry to the `switch` in `src/llm/factory.ts`.
3. Extend `YunseulSettings` with a sub-object for your provider's knobs and add defaults to `DEFAULT_SETTINGS`. Update `migrateSettings()` so older data files heal in.
4. Render the provider's settings group in the `display()` method of the `SettingTab` in `src/settings.ts`, gated on the provider discriminator.
5. Add a kind-specific arm to the offline banner copy in `src/ui/AIChatView.ts` so users get a useful message when your `probe()` fails.
6. Write a focused vitest suite under `tests/` using `tests/_stubs/obsidian.ts`. Aim for one happy-path stream, one abort, one probe failure, and any provider-specific edge cases (auth refresh, subprocess respawn, etc.).

## How to add a setting

1. Add the field to `YunseulSettings` under the right sub-object (`lmStudio`, `claudeCode`, `chat`, `index`, `privacy`, or top-level for cross-cutting flags).
2. Add a sensible default to `DEFAULT_SETTINGS`.
3. Extend `migrateSettings()` so older `data.json` files without the field load cleanly. The grouped-shape branch fills missing nested keys against `DEFAULT_SETTINGS` already; you only need to handle the v0 (flat) lift path if your field has a pre-v1 ancestor.
4. Add tests to `tests/settings-migration.test.ts` covering the v0 lift, the v1 partial heal, and any type-validation fallback.
5. Render the control in the `SettingTab.display()` method (`src/settings.ts`), using sentence case for labels and the appropriate `Setting` builder (`addText`, `addToggle`, `addSlider`, …).
6. Wire any call sites that read the new field; if it affects the active LLM client, call `plugin.rebuildLLMClient()` after persist so the change takes effect without a reload.

## Releasing

1. Bump the version in `manifest.json` (semver) and run `npm version <patch|minor|major>` — the `version` script runs `version-bump.mjs` which also updates `versions.json` and stages both files. `versions.json` maps the new plugin version to the current `minAppVersion` from `manifest.json`; the two files must agree.
2. Update `CHANGELOG.md` — move items from `[Unreleased]` into a new dated section, grouped under Added / Changed / Fixed / Security / Performance / Accessibility / Deprecated / Known limitations as appropriate.
3. Commit the version bump + changelog edit together.
4. Tag the commit with the bare version (no leading `v`): `git tag 0.2.0 && git push --tags`.
5. The release workflow under `.github/workflows/` produces a GitHub release with `main.js`, `manifest.json`, and `styles.css` attached as individual assets. The Obsidian community-plugin loader and BRAT both consume those three release assets, not the repo files.

## Reporting bugs / proposing changes

Open an issue with the failure mode, the provider you're on, the relevant settings (with secrets redacted), and any error notice text. For larger changes, open a discussion first — Yunseul is small and opinionated, and we'd rather sketch an approach together than ask you to rewrite a finished PR.
