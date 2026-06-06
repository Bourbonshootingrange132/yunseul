import { addIcon, Notice, Plugin, type TAbstractFile, TFile, type WorkspaceLeaf } from 'obsidian';
import {
	migrateSettingsWithFlag,
	YunseulSettingTab,
	type YunseulSettings,
} from './settings';
import { LMClient } from './lmstudio/client';
import { ClaudeCodeClient } from './claude-code/client';
import type { ConnectionState, ConnectionStatusValue } from './lmstudio/health';
import { makeLLMClient } from './llm/factory';
import type { LLMClient } from './llm/types';
import { AIChatView, VIEW_TYPE_AI_CHAT } from './ui/AIChatView';
import { IndexPromptModal } from './ui/IndexPromptModal';
import { ResetIndexConfirmModal } from './ui/ResetIndexConfirmModal';
import { ChatSession } from './chat/session';
import { debouncedSaver, loadAllSessions, type DebouncedSaver } from './chat/persist';
import { makeLog, type Logger } from './util/log';
import { bm25IndexPath, sessionsDir } from './util/paths';
import { VaultRetriever } from './index/retriever';
import { isAbortError } from './util/guards';

// Plugin root. Owns every shared resource — sessions, LMClient,
// settings, connection-state pub-sub. Views are intentionally thin:
// they read state from here and subscribe to changes. Closing/reopening
// a view leaf doesn't touch any of this.

type ConnectionListener = (state: ConnectionState) => void;
type SettingsListener = () => void;

// Debounce window for the incremental BM25 reindex pipeline. Matches
// the plan's 1500 ms — long enough that batch saves (a folder rename,
// say) coalesce into one update, short enough that a quick edit-then-
// ask flow sees fresh context.
const REINDEX_DEBOUNCE_MS = 1500;
// Window after a save() before we trust persistence is durable.
// Plugin shutdown awaits this many ms to flush in-flight writes.
const SAVE_BACKOFF_MS = 250;

export default class YunseulPlugin extends Plugin {
	settings!: YunseulSettings;
	logger!: Logger;
	// Field name kept as `lmClient` for backward compatibility with the
	// rest of the codebase that pre-dates the provider abstraction.
	// The runtime type is the provider-neutral `LLMClient`; the field
	// gets swapped out by `rebuildLLMClient()` when the user changes
	// providers in settings.
	lmClient!: LLMClient;
	sessions = new Map<string, ChatSession>();
	retriever: VaultRetriever | null = null;
	private activeSessionId: string | null = null;
	private connectionState: ConnectionState = { state: 'unknown' };
	private connectionListeners = new Set<ConnectionListener>();
	private settingsListeners = new Set<SettingsListener>();
	private saveSession: DebouncedSaver | null = null;
	private unloaded = false;
	// Per-file debounce timer for the metadataCache.changed pipeline.
	// Keyed by file path so two distinct files don't squash each other.
	// We track the TFile alongside the timer so onunload() can flush any
	// pending reindexes synchronously before the final save() — otherwise
	// an edit-then-quit within the 1500 ms debounce window would lose
	// that edit until the next change event after restart.
	private reindexTimers = new Map<string, { timer: number; file: TFile }>();
	private indexBuildInFlight = false;
	private indexBuildAbortCtrl: AbortController | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.logger = makeLog(() => this.settings.debug);
		this.lmClient = makeLLMClient(this);
		this.saveSession = debouncedSaver(this.app.vault.adapter, sessionsDir(this));

		// addIcon is Obsidian's documented icon-registry API; its SVG string
		// is owned by Obsidian, not plugin DOM. All other icon usage in this
		// plugin goes through setIcon(name) helper.
		addIcon(
			'yunseul',
			'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" focusable="false" aria-hidden="true"><rect x="1" y="3" width="14" height="10" rx="2" stroke-width="1.5"/><path d="M2 12 L14 4" stroke-width="1.5" opacity="0.6"/></svg>',
		);

		this.addRibbonIcon('yunseul', 'Open chat', () => {
			void this.activateView();
		});

		this.registerView(VIEW_TYPE_AI_CHAT, (leaf: WorkspaceLeaf) => new AIChatView(leaf, this));

		this.addCommand({
			id: 'open-chat',
			name: 'Open chat',
			callback: () => {
				void this.activateView();
			},
		});

		// State-dependent commands use checkCallback so they hide from
		// the palette when their preconditions aren't met. Per Obsidian
		// guideline: "Force re-index" / "Reset" only make sense once
		// vault search has been accepted; "Enable vault search" only
		// makes sense while it's currently off.
		this.addCommand({
			id: 'force-reindex',
			name: 'Force re-index vault',
			checkCallback: (checking) => {
				if (
					this.settings.index.promptState !== 'accepted' ||
					!this.settings.index.enabled
				) return false;
				if (!checking) void this.startVaultIndexBuild('force');
				return true;
			},
		});

		this.addCommand({
			id: 'reset-index',
			name: 'Reset vault index',
			checkCallback: (checking) => {
				if (this.settings.index.promptState !== 'accepted') return false;
				if (!checking) this.promptResetVaultIndex();
				return true;
			},
		});

		this.addCommand({
			id: 'enable-vault-search',
			name: 'Enable vault search',
			checkCallback: (checking) => {
				if (this.settings.index.enabled) return false;
				if (!checking) void this.enableVaultSearch();
				return true;
			},
		});

		this.addSettingTab(new YunseulSettingTab(this.app, this));

		await this.restoreSessions();

		// Background probe so the banner reflects the current state
		// without forcing the user to click "Test". We do this in
		// onLayoutReady so we don't slow plugin enable. Guard the
		// callback body with `unloaded` so a layout-ready event during
		// disable doesn't poke a torn-down client.
		this.app.workspace.onLayoutReady(() => {
			if (this.unloaded) return;
			void this.refreshConnectionState();
			void this.bootstrapRetriever();
		});

		this.wireRetrieverListeners();
	}

	onunload(): void {
		// Mark unloaded first so any in-flight async callbacks
		// (onLayoutReady, post-debounce timers) short-circuit.
		this.unloaded = true;
		// Abort the in-flight vault index build (if any) so the build
		// loop stops touching the torn-down retriever and the user
		// doesn't wait minutes on disable/upgrade.
		if (this.indexBuildAbortCtrl !== null) {
			this.indexBuildAbortCtrl.abort();
		}
		// Abort any in-flight streams so we don't leak fetch readers
		// past plugin disable. Persistence is debounced; refresh the
		// pending snapshot for each session (in case the stream had
		// not yet pushed a debounce update) and flush so the user
		// doesn't lose the last 0–2 s of streaming on disable/upgrade.
		for (const s of this.sessions.values()) {
			// Push the latest snapshot into the debounce queue so
			// flush() picks it up.
			this.persistSession(s);
			s.stop();
		}
		// Kill any subprocess the Claude Code client started but didn't
		// see closed yet — onunload races the abort dispatch above.
		// killAll() marks each live proc as aborted, so the close
		// handler routes through opts.onComplete (clean) rather than
		// opts.onError (which would push a spurious error into the
		// persisted assistant bubble right before we serialize it).
		if (this.lmClient instanceof ClaudeCodeClient) {
			this.lmClient.killAll();
		}
		// Fire-and-forget — we cannot await inside onunload, but the
		// internal queue ensures writes complete in order. If Obsidian
		// is shutting down the process, the underlying adapter has
		// time to finish before the event loop spins down.
		//
		// After scheduling the flush, cancel() the saver so subprocess
		// close handlers that fire post-unload (and call persistSession
		// again from session.send's onComplete) become no-ops. Without
		// this, the debounce queue keeps accepting work and the plugin
		// reference stays referenced past unload.
		if (this.saveSession !== null) {
			const saver = this.saveSession;
			void saver.flush().finally(() => {
				saver.cancel();
			});
		}
		// Drain pending reindex timers: capture their files, cancel the
		// timers, then kick off a single batched reindex + save so an
		// edit-then-quit within the debounce window still lands on disk.
		// A rename-then-quit (which clears the old path's timer
		// synchronously and schedules a new one) is also covered because
		// the new timer is captured here. We fire-and-forget the chain
		// since onunload cannot await.
		const pendingFiles: TFile[] = [];
		for (const { timer, file } of this.reindexTimers.values()) {
			window.clearTimeout(timer);
			pendingFiles.push(file);
		}
		this.reindexTimers.clear();
		if (this.retriever !== null) {
			const retriever = this.retriever;
			void (async (): Promise<void> => {
				for (const f of pendingFiles) {
					try {
						await retriever.reindexFile(f);
					} catch {
						// Best-effort; a per-file failure must not
						// block the others or the final save.
					}
				}
				try {
					await retriever.save();
				} catch {
					// On unload there's no good way to surface a
					// failure; the next launch will load the previous
					// snapshot.
				}
			})();
		}
		this.connectionListeners.clear();
		this.settingsListeners.clear();
	}

	async loadSettings(): Promise<void> {
		const stored: unknown = await this.loadData();
		const { settings, migrated } = migrateSettingsWithFlag(stored);
		this.settings = settings;
		// Persist the migrated shape only when something actually changed
		// (v0 → v1 lift, defaulted nested group, healed wrong-typed value,
		// or null → defaults). On a clean v1-identity load we leave
		// data.json untouched — otherwise every plugin launch would
		// trigger a write (and an Obsidian-Sync round-trip) even when
		// the user changed nothing.
		if (migrated) {
			await this.saveData(this.settings);
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		for (const l of this.settingsListeners) l();
	}

	/**
	 * Subscribe to settings changes. Mirrors onConnectionStateChange.
	 * Used by AIChatView to refresh the status strip when the user edits
	 * settings while the chat panel is open. Returns an unsubscribe
	 * function — callers MUST call it on view close to prevent the
	 * listener from leaking past the view's lifecycle.
	 */
	onSettingsChange(listener: SettingsListener): () => void {
		this.settingsListeners.add(listener);
		return () => {
			this.settingsListeners.delete(listener);
		};
	}

	async activateView(): Promise<void> {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(VIEW_TYPE_AI_CHAT);
		if (existing.length > 0) {
			const leaf = existing[0];
			if (leaf !== undefined) {
				await workspace.revealLeaf(leaf);
				return;
			}
		}
		const right = workspace.getRightLeaf(false);
		if (right === null) return;
		await right.setViewState({ type: VIEW_TYPE_AI_CHAT, active: true });
		await workspace.revealLeaf(right);
	}

	// ---- Session management -------------------------------------------------

	getOrCreateActiveSessionId(): string {
		if (this.activeSessionId !== null && this.sessions.has(this.activeSessionId)) {
			return this.activeSessionId;
		}
		// Reuse the most recently updated existing session if any —
		// the user re-opens the leaf and expects to land back in
		// their last conversation.
		let mostRecent: ChatSession | null = null;
		for (const s of this.sessions.values()) {
			if (mostRecent === null || s.updatedAt > mostRecent.updatedAt) mostRecent = s;
		}
		if (mostRecent !== null) {
			this.activeSessionId = mostRecent.id;
			return mostRecent.id;
		}
		return this.createSession();
	}

	createSession(): string {
		const s = new ChatSession(this);
		this.sessions.set(s.id, s);
		this.activeSessionId = s.id;
		this.persistSession(s);
		return s.id;
	}

	setActiveSessionId(id: string): void {
		this.activeSessionId = id;
	}

	persistSession(session: ChatSession): void {
		if (this.saveSession === null) return;
		this.saveSession(session.id, session.toSnapshot());
	}

	private async restoreSessions(): Promise<void> {
		try {
			const snapshots = await loadAllSessions(this.app.vault.adapter, sessionsDir(this));
			for (const snap of snapshots) {
				// Drop trailing empty assistant placeholders. These can
				// be persisted if a stream was aborted before any token
				// arrived; restoring them would render a permanent blank
				// assistant bubble.
				while (snap.history.length > 0) {
					const last = snap.history[snap.history.length - 1];
					if (last?.role === 'assistant' && last.content.length === 0) {
						snap.history.pop();
						continue;
					}
					break;
				}
				const session = new ChatSession(this, snap);
				if (snap.boundFilePath !== null) {
					const af = this.app.vault.getAbstractFileByPath(snap.boundFilePath);
					if (af instanceof TFile) {
						session.boundFile = af;
					}
				}
				this.sessions.set(session.id, session);
			}
		} catch (e) {
			this.logger.error(
				`Session restore failed: ${e instanceof Error ? e.message : String(e)}`,
				'Could not restore previous sessions.',
			);
		}
	}

	// ---- Connection state pub-sub ------------------------------------------

	getConnectionState(): ConnectionState {
		return this.connectionState;
	}

	/**
	 * Update the plugin-level connection state and fan out to listeners.
	 *
	 * Accepts either a bare status value (`'ready' | 'offline' | 'unknown'`)
	 * for legacy call sites that only know the binary up/down state, or
	 * a full envelope `{ state, message?, kind? }` for callers that have
	 * the provider's probe result and want the banner to render a kind-
	 * specific actionable message. Listeners always receive the full
	 * envelope so the banner has access to `.message` when present.
	 */
	updateConnectionState(next: ConnectionState | ConnectionStatusValue): void {
		const envelope: ConnectionState = typeof next === 'string' ? { state: next } : next;
		// Diff on the discrete state + the actionable message. The kind
		// field rides along for analytics but doesn't gate the listener
		// fan-out — two probes that both report `offline` with the same
		// message but different kinds shouldn't re-render the banner.
		if (
			this.connectionState.state === envelope.state &&
			this.connectionState.message === envelope.message
		) {
			return;
		}
		this.connectionState = envelope;
		for (const l of this.connectionListeners) l(envelope);
	}

	onConnectionStateChange(listener: ConnectionListener): () => void {
		this.connectionListeners.add(listener);
		return () => {
			this.connectionListeners.delete(listener);
		};
	}

	async refreshConnectionState(): Promise<void> {
		try {
			// The provider-neutral probe() returns ProbeResult { ok, kind, message }.
			// Carry kind + message into the connection envelope so the
			// banner can render provider-aware actionable text (LM Studio
			// CORS guidance, Claude Code "claude login" hint, etc.) without
			// having to re-probe.
			const result = await this.lmClient.probe();
			this.updateConnectionState({
				state: result.ok ? 'ready' : 'offline',
				message: result.message,
				kind: result.kind,
			});
		} catch (e) {
			this.logger.warn(
				`Health check threw: ${e instanceof Error ? e.message : String(e)}`,
			);
			this.updateConnectionState({ state: 'offline' });
		}
	}

	/**
	 * Swap the active LLM client to the one implied by `settings.provider`.
	 * Called from the settings tab after the provider dropdown changes
	 * so the next user message routes through the new backend. Best-
	 * effort kicks off a probe so the chat banner reflects reality
	 * within a second of the swap.
	 */
	rebuildLLMClient(): void {
		// Abort any in-flight session stream on the OLD provider before
		// swapping. Without this, the session's AbortController is left
		// listening for a signal that will never arrive (since the new
		// client doesn't share state with the old one), the streaming
		// bubble dangles, and the user sees no clear feedback that the
		// provider switch interrupted their stream.
		let hadStreaming = false;
		for (const s of this.sessions.values()) {
			if (s.isStreaming()) {
				hadStreaming = true;
				s.stop();
			}
		}
		// Tear down the previous claude subprocess pool before swapping
		// it out — otherwise the stale processes leak past the swap and
		// fight the new client for the user prompt on stdin.
		if (this.lmClient instanceof ClaudeCodeClient) {
			this.lmClient.killAll();
		}
		this.lmClient = makeLLMClient(this);
		if (hadStreaming) {
			new Notice('Provider switched; pending stream cancelled.');
		}
		// Push the connection state back to 'unknown' so the banner
		// doesn't show a stale 'ready' from the previous backend while
		// we probe the new one.
		this.updateConnectionState({ state: 'unknown' });
		void this.refreshConnectionState();
	}

	/**
	 * Return the LMClient instance (constructing one if the active
	 * provider is something else). The settings tab uses this for the
	 * rich `runHealthCheck` which needs the CORS-blocked flag from
	 * `LMClient.probeDetailed()`. This is intentionally a settings-only
	 * affordance — the chat path always goes through the active
	 * `lmClient` LLMClient.
	 */
	getLMStudioClient(): LMClient {
		if (this.lmClient instanceof LMClient) return this.lmClient;
		return new LMClient(() => this.settings);
	}

	// ---- Vault retrieval (BM25) -------------------------------------------

	/**
	 * On layout ready: if the user previously accepted indexing, init
	 * the retriever and load (or rebuild) the index. If they haven't
	 * answered the first-run prompt yet, surface the modal once the
	 * workspace settles.
	 */
	private async bootstrapRetriever(): Promise<void> {
		if (this.unloaded) return;
		if (this.settings.index.promptState === 'accepted' && this.settings.index.enabled) {
			this.retriever = new VaultRetriever(this, bm25IndexPath(this));
			const loaded = await this.retriever.load();
			if (!loaded && !this.unloaded) {
				// Background-build so the first chat with retrieval has
				// fresh data. The Notice is intentionally low-key — most
				// users will not need to see this.
				void this.startVaultIndexBuild('initial');
			}
		} else if (this.settings.index.promptState === 'unanswered') {
			// Defer the modal until the workspace is fully settled; the
			// IndexPromptModal reads vault.getMarkdownFiles() for the
			// count, which is stable post-layout.
			new IndexPromptModal(this.app, this).open();
		}
	}

	private wireRetrieverListeners(): void {
		// metadataCache.on('changed') fires on save AND on rename target;
		// debounce per-file so a quick save burst (autosave) collapses
		// to one rebuild call.
		this.registerEvent(
			this.app.metadataCache.on('changed', (file: TFile) => {
				if (this.retriever === null) return;
				this.scheduleReindex(file);
			}),
		);
		this.registerEvent(
			this.app.vault.on('create', (file: TAbstractFile) => {
				if (this.retriever === null) return;
				if (file instanceof TFile && file.extension === 'md') {
					this.scheduleReindex(file);
				}
			}),
		);
		this.registerEvent(
			this.app.vault.on('delete', (file: TAbstractFile) => {
				if (this.retriever === null) return;
				if (file instanceof TFile) {
					// Cancel any pending reindex timer first so it can't
					// resurrect the deleted file by re-reading it after
					// we drop it from the index.
					this.clearReindexTimer(file.path);
					this.retriever.removeFile(file.path);
					void this.retriever.save().catch(() => {
						// Save failures here are non-fatal; the next
						// successful save catches up.
					});
				}
			}),
		);
		this.registerEvent(
			this.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
				if (this.retriever === null) return;
				if (file instanceof TFile && file.extension === 'md') {
					// Drop any pending reindex timer keyed by the OLD path
					// — if we left it, it would fire after the file has
					// been re-keyed in the index under its new path.
					this.clearReindexTimer(oldPath);
					this.retriever.removeFile(oldPath);
					this.scheduleReindex(file);
				}
			}),
		);
	}

	private scheduleReindex(file: TFile): void {
		// IMPORTANT: capture file.path as a string at schedule time.
		// Obsidian mutates TFile.path in place on rename, so reading
		// `file.path` inside the timer callback would key against the
		// post-rename path and miss the original entry — leaking timers
		// and risking redundant or concurrent reindex/save runs.
		const key = file.path;
		const existing = this.reindexTimers.get(key);
		if (existing !== undefined) window.clearTimeout(existing.timer);
		const t = window.setTimeout(() => {
			this.reindexTimers.delete(key);
			if (this.retriever === null) return;
			void this.retriever.reindexFile(file).then(() => {
				if (this.retriever !== null) void this.retriever.save();
			});
		}, REINDEX_DEBOUNCE_MS);
		this.reindexTimers.set(key, { timer: t, file });
	}

	private clearReindexTimer(path: string): void {
		const existing = this.reindexTimers.get(path);
		if (existing !== undefined) {
			window.clearTimeout(existing.timer);
			this.reindexTimers.delete(path);
		}
	}

	async startVaultIndexBuild(reason: 'initial' | 'force'): Promise<void> {
		if (this.indexBuildInFlight) {
			new Notice('Vault index build already in progress.');
			return;
		}
		// Snapshot the previous retriever before the build mutates state.
		// VaultRetriever owns the BM25Index it builds into; if the user (or
		// onunload) cancels mid-loop, `buildFromVault` throws AbortError
		// leaving a PARTIAL index in memory. Without this snapshot the next
		// `metadataCache.changed` event would call `retriever.save()` and
		// overwrite the on-disk full index with the partial one. The
		// integration invariant ("partial-index never persists") lives
		// here in startVaultIndexBuild; the BM25Index-level invariant
		// ("partial-state is well-formed") is exercised in tests/bm25.test.ts.
		const prevRetriever = this.retriever;
		if (this.retriever === null || reason === 'force') {
			this.retriever = new VaultRetriever(this, bm25IndexPath(this));
		}
		this.indexBuildInFlight = true;
		const abortCtrl = new AbortController();
		this.indexBuildAbortCtrl = abortCtrl;
		const startedAt = Date.now();
		const total = this.app.vault.getMarkdownFiles().length;
		const verb = reason === 'force' ? 'Rebuilding' : 'Building';
		const notice = new Notice(`${verb} vault index... (0 / ${total})`, 0);
		// Wire a Cancel affordance into the persistent Notice. The X
		// glyph rendered by Obsidian for `new Notice(..., 0)` only
		// hides the toast; a real cancel must abort the build loop.
		// We use `noticeEl` (the deprecated alias of `messageEl`) because
		// `messageEl` requires Obsidian 1.8.7 and our minAppVersion is
		// 1.7.2. Lint exemption below.
		// eslint-disable-next-line @typescript-eslint/no-deprecated
		const noticeEl = notice.noticeEl;
		let cancelBtn: HTMLButtonElement | null = null;
		if (noticeEl !== undefined) {
			cancelBtn = noticeEl.createEl('button', {
				text: 'Cancel',
				cls: 'yunseul-notice-cancel',
				attr: { 'aria-label': 'Cancel vault index build' },
			});
			this.registerDomEvent(cancelBtn, 'click', () => abortCtrl.abort());
		}
		try {
			let lastUpdate = 0;
			await this.retriever.buildFromVault({
				signal: abortCtrl.signal,
				onProgress: (done, t2) => {
					const now = Date.now();
					if (now - lastUpdate < 200 && done !== t2) return;
					lastUpdate = now;
					notice.setMessage(`${verb} vault index... (${done} / ${t2})`);
				},
			});
			await this.retriever.save();
			const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
			if (cancelBtn !== null) cancelBtn.remove();
			notice.setMessage(`Vault index ready (${this.retriever.size()} files, ${elapsedSec}s).`);
			window.setTimeout(() => notice.hide(), 4000);
		} catch (e) {
			notice.hide();
			if (isAbortError(e)) {
				// Quiet path: the user (or onunload) cancelled. Restore
				// the previous retriever so any follow-up reindex/save
				// from the metadataCache pipeline targets the last
				// known-good index, not the partial one we left behind
				// in `this.retriever`. If there was no previous retriever
				// (first-run build cancelled before any index existed),
				// drop the partial entirely so no save can later persist it.
				this.retriever = prevRetriever;
				if (!this.unloaded) {
					new Notice('Index build cancelled — previous index preserved.');
				}
			} else {
				// Non-abort errors are real bugs and must surface — do
				// NOT restore the snapshot here so the failure mode is
				// visible. The retriever is left in whatever partial
				// state it reached; the next force-rebuild will replace it.
				this.logger.error(
					`Vault index build failed: ${e instanceof Error ? e.message : String(e)}`,
					'Vault index build failed. See console for details.',
				);
			}
		} finally {
			this.indexBuildInFlight = false;
			this.indexBuildAbortCtrl = null;
			// Tiny backoff so a follow-up save() from the listener
			// pipeline doesn't race the build's save().
			await new Promise((r) => window.setTimeout(r, SAVE_BACKOFF_MS));
		}
	}

	/**
	 * Surface the reset confirmation modal. Both the command palette
	 * and the settings "Reset" button funnel through this so a single
	 * mis-click never destroys the index without an explicit confirm.
	 */
	promptResetVaultIndex(): void {
		const path = bm25IndexPath(this);
		new ResetIndexConfirmModal(this.app, {
			indexPath: path,
			onConfirm: () => {
				void this.resetVaultIndex();
			},
		}).open();
	}

	async resetVaultIndex(): Promise<void> {
		// Cancel any in-flight build so we don't race the abort against
		// the impending file removal.
		if (this.indexBuildAbortCtrl !== null) {
			this.indexBuildAbortCtrl.abort();
		}
		// Drop pending reindex timers — they would re-add entries we
		// are about to delete.
		for (const { timer } of this.reindexTimers.values()) window.clearTimeout(timer);
		this.reindexTimers.clear();
		// Drop the in-memory retriever, the on-disk index, and flip the
		// state back to declined so we don't immediately re-prompt or
		// re-build on next launch.
		this.retriever = null;
		this.settings.index.enabled = false;
		this.settings.index.promptState = 'declined';
		await this.saveSettings();
		const path = bm25IndexPath(this);
		const adapter = this.app.vault.adapter;
		try {
			if (await adapter.exists(path)) {
				await adapter.remove(path);
			}
			new Notice('Vault index removed. Use "Enable vault search" to rebuild.');
		} catch (e) {
			this.logger.error(
				`Failed to remove index file: ${e instanceof Error ? e.message : String(e)}`,
				'Could not remove the index file. See console.',
			);
		}
	}

	async enableVaultSearch(): Promise<void> {
		this.settings.index.promptState = 'accepted';
		this.settings.index.enabled = true;
		await this.saveSettings();
		if (this.retriever === null) {
			this.retriever = new VaultRetriever(this, bm25IndexPath(this));
		}
		const loaded = await this.retriever.load();
		if (!loaded) {
			await this.startVaultIndexBuild('initial');
		} else {
			new Notice('Vault search enabled. Existing index loaded.');
		}
	}
}

