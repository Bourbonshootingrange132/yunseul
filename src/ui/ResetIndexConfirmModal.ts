import { type App, Component, Modal } from 'obsidian';

// Confirmation modal for the destructive "Reset vault index" action.
// The reset command and the settings button both funnel through here so
// a single mis-click cannot destroy the index file and force a 20+ minute
// rebuild. Mirrors the IndexPromptModal styling so the two read as a
// matched pair (one builds, one tears down).

export interface ResetIndexConfirmOpts {
	indexPath: string;
	onConfirm: () => void;
}

export class ResetIndexConfirmModal extends Modal {
	private readonly opts: ResetIndexConfirmOpts;
	private readonly lifecycle = new Component();

	constructor(app: App, opts: ResetIndexConfirmOpts) {
		super(app);
		this.opts = opts;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		// Reset modal carries BOTH classes: `.yunseul-reset-modal` is the
		// plan-intended scope (so future reset-only styling lands on the
		// element), `.yunseul-index-modal` keeps inheriting the shared
		// modal layout rules (note/actions/warning) until/unless those are
		// re-declared under the reset scope.
		contentEl.addClass('yunseul-reset-modal');
		contentEl.addClass('yunseul-index-modal');
		this.lifecycle.load();

		this.setTitle('Reset vault index?');

		const intro = contentEl.createEl('p');
		intro.setText(
			'This deletes the on-disk index file and disables vault search.',
		);

		const pathRow = contentEl.createEl('p');
		pathRow.createSpan({ text: 'File to remove: ' });
		pathRow.createEl('code', { text: this.opts.indexPath });

		const impact = contentEl.createEl('p', { cls: 'yunseul-index-modal-note' });
		impact.setText(
			'You will need to rebuild before the assistant can search your vault. On a large vault the rebuild can take several minutes.',
		);

		const actions = contentEl.createDiv({ cls: 'yunseul-index-modal-actions' });

		const cancelBtn = actions.createEl('button', { text: 'Cancel' });
		this.lifecycle.registerDomEvent(cancelBtn, 'click', () => this.close());

		const confirmBtn = actions.createEl('button', {
			text: 'Reset index',
			cls: 'mod-warning',
		});
		this.lifecycle.registerDomEvent(confirmBtn, 'click', () => {
			this.opts.onConfirm();
			this.close();
		});

		// Initial focus on the SAFE action — WCAG 2.4.3. ResetIndexConfirmModal
		// is destructive (deletes the on-disk index file and forces a 20+
		// minute rebuild), so focus lands on Cancel rather than the
		// confirmatory mod-warning button. A user who hits Enter immediately
		// after the modal opens gets a no-op rather than data loss.
		cancelBtn.focus();
	}

	onClose(): void {
		this.lifecycle.unload();
		this.contentEl.empty();
	}
}
