import { type App, Component, Modal, Notice } from 'obsidian';
import type YunseulPlugin from '../main';

// First-run modal for vault-wide BM25 indexing. Per the plan we offer
// three explicit choices — Index now / Skip for now / Don't ask again —
// each mapping to a tri-state `indexPromptState` setting so subsequent
// sessions know whether to re-prompt or stay quiet.
//
// We compose with an internal Component for DOM listener lifecycle
// (the same pattern used by AppendPreviewModal). Obsidian's Modal does
// not itself extend Component, so we own the component lifecycle
// explicitly. All DOM is built via createDiv/createEl/setText — no
// innerHTML, per the plan's DOM rules.

// Resource thresholds. Above WARN_FILE_COUNT we surface a stronger
// warning so the user knows the build will take meaningful time and
// disk. Above HARD_FILE_COUNT we still allow indexing but call out
// the multi-tens-of-minutes runtime explicitly and recommend the
// exclude-tags setting to scope down.
export const WARN_FILE_COUNT = 5_000;
export const HARD_FILE_COUNT = 50_000;

export class IndexPromptModal extends Modal {
	private readonly plugin: YunseulPlugin;
	private readonly lifecycle = new Component();

	constructor(app: App, plugin: YunseulPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('yunseul-index-modal');
		this.lifecycle.load();

		this.setTitle('Search across your vault?');

		const intro = contentEl.createEl('p');
		intro.setText(
			'Yunseul can index your vault so the assistant can find relevant notes for every question.',
		);

		const fileCount = this.plugin.app.vault.getMarkdownFiles().length;
		// Honest time estimate: a single-doc index step takes ~25 ms on a
		// warm cache (best case) but 3-5x that on a cold disk or with
		// large notes. We surface the upper bound rather than the average
		// so the user is prepared for a slower-than-average rebuild
		// instead of abandoning the operation mid-way.
		const estSecondsMax = Math.max(4, Math.round(fileCount * 0.1));
		const estLabel = estSecondsMax >= 60
			? `up to ${Math.ceil(estSecondsMax / 60)} minute${estSecondsMax >= 120 ? 's' : ''}`
			: `up to ${estSecondsMax} second${estSecondsMax === 1 ? '' : 's'}`;

		const summary = contentEl.createEl('p');
		summary.setText(
			`About to index ${fileCount} markdown file${fileCount === 1 ? '' : 's'}. This takes ${estLabel} and stays on this machine — the index is saved to .yunseul/bm25-index.json in your vault.`,
		);

		if (fileCount >= HARD_FILE_COUNT) {
			const hardWarn = contentEl.createEl('p', { cls: 'yunseul-index-modal-warning' });
			hardWarn.setText(
				`Heads-up: ${fileCount} files is on the high end. The build can take tens of minutes and the resulting index can use hundreds of megabytes of memory and disk. Consider scoping with "Exclude tags" in settings before continuing.`,
			);
		} else if (fileCount >= WARN_FILE_COUNT) {
			const warn = contentEl.createEl('p', { cls: 'yunseul-index-modal-warning' });
			warn.setText(
				`Heads-up: this is a large vault. The build will take several minutes and the index file may be tens to hundreds of megabytes.`,
			);
		}

		const note = contentEl.createEl('p', { cls: 'yunseul-index-modal-note' });
		note.setText(
			'The index file lives under your vault root, so sync tools (Syncthing, iCloud, git) will see it. See the README for ignore patterns. You can change these settings later in Settings → Yunseul → Vault search.',
		);

		const actions = contentEl.createDiv({ cls: 'yunseul-index-modal-actions' });

		const indexBtn = actions.createEl('button', {
			text: 'Index now',
			cls: 'mod-cta',
		});
		this.lifecycle.registerDomEvent(indexBtn, 'click', () => {
			void this.handleIndexNow();
		});

		const skipBtn = actions.createEl('button', { text: 'Skip for now' });
		this.lifecycle.registerDomEvent(skipBtn, 'click', () => {
			void this.handleSkip();
		});

		const declineBtn = actions.createEl('button', { text: "Don't ask again" });
		this.lifecycle.registerDomEvent(declineBtn, 'click', () => {
			void this.handleDecline();
		});

		// Initial focus on the primary action — WCAG 2.4.3. IndexPromptModal
		// is a confirmatory first-run dialog, so focus lands on the
		// "Index now" CTA. Destructive modals (see ResetIndexConfirmModal)
		// focus their Cancel button instead.
		indexBtn.focus();
	}

	onClose(): void {
		this.lifecycle.unload();
		this.contentEl.empty();
	}

	private async handleIndexNow(): Promise<void> {
		this.plugin.settings.index.promptState = 'accepted';
		this.plugin.settings.index.enabled = true;
		await this.plugin.saveSettings();
		this.close();
		// Kick off the build through the plugin command so all surfaces
		// (settings button, modal, command palette) share one code path.
		await this.plugin.startVaultIndexBuild('initial');
	}

	private async handleSkip(): Promise<void> {
		this.plugin.settings.index.promptState = 'unanswered';
		await this.plugin.saveSettings();
		new Notice('Vault search skipped. You will be asked again on the next session.');
		this.close();
	}

	private async handleDecline(): Promise<void> {
		this.plugin.settings.index.promptState = 'declined';
		this.plugin.settings.index.enabled = false;
		await this.plugin.saveSettings();
		new Notice('Vault search disabled. Re-enable any time from Settings.');
		this.close();
	}
}
