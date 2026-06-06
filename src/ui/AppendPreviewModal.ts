import { type App, Component, Modal, type TFile } from 'obsidian';

// Confirmation modal for "Append reply to <note>". The user sees the
// target path and the text that will be appended. A checkbox lets
// them strip a trailing "Sources:" section before appending, because
// V1 may add citation footers and a user may not want those in the
// note. We compose with an internal `Component` so DOM listeners are
// registered through `registerDomEvent` and auto-cleaned on close.
// Obsidian's `Modal` does not itself extend `Component`, so we own
// the component lifecycle explicitly.

export interface AppendPreviewOpts {
	file: TFile;
	replyText: string;
	stripSources: boolean;
	onConfirm: (finalText: string) => void;
}

export class AppendPreviewModal extends Modal {
	private readonly opts: AppendPreviewOpts;
	private stripSources: boolean;
	private readonly lifecycle = new Component();

	constructor(app: App, opts: AppendPreviewOpts) {
		super(app);
		this.opts = opts;
		this.stripSources = opts.stripSources;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('yunseul-append-modal');
		this.lifecycle.load();

		this.setTitle('Append to note');

		const targetWrap = contentEl.createDiv({ cls: 'yunseul-append-target' });
		targetWrap.createSpan({ text: 'Target: ' });
		targetWrap.createEl('code', { text: this.opts.file.path });

		const previewLabel = contentEl.createEl('div', {
			cls: 'yunseul-append-label',
			text: 'Preview',
		});
		previewLabel.setAttr('aria-hidden', 'true');

		// `<pre>` carries the scrollable region — make it focusable so
		// keyboard users can scroll it with arrow keys (audit A4). Without
		// tabindex=0 only mouse-wheel users could scroll a long preview.
		// role=region + aria-label exposes it as a navigable landmark to AT.
		const preview = contentEl.createEl('pre', {
			cls: 'yunseul-append-preview',
			attr: { tabindex: '0', role: 'region', 'aria-label': 'Preview' },
		});
		const previewCode = preview.createEl('code');
		previewCode.setText(this.previewText());

		const optionsRow = contentEl.createDiv({ cls: 'yunseul-append-options' });
		// crypto.randomUUID is available in Obsidian's electron build.
		// Date.now() collides if the modal opens twice in the same ms,
		// which breaks the label/for association for screen readers.
		const stripId = `yunseul-strip-${makeShortId()}`;
		const stripLabel = optionsRow.createEl('label', { attr: { for: stripId } });
		const stripCheck = stripLabel.createEl('input', {
			attr: { type: 'checkbox', id: stripId },
		});
		if (this.stripSources) stripCheck.checked = true;
		stripLabel.createSpan({ text: ' Strip "Sources:" section if present' });
		this.lifecycle.registerDomEvent(stripCheck, 'change', () => {
			this.stripSources = stripCheck.checked;
			previewCode.setText(this.previewText());
		});

		const actions = contentEl.createDiv({ cls: 'yunseul-append-actions' });
		const cancelBtn = actions.createEl('button', { text: 'Cancel' });
		this.lifecycle.registerDomEvent(cancelBtn, 'click', () => this.close());
		const confirmBtn = actions.createEl('button', {
			text: 'Append',
			cls: 'mod-cta',
		});
		this.lifecycle.registerDomEvent(confirmBtn, 'click', () => {
			const finalText = this.finalText();
			this.opts.onConfirm(finalText);
			this.close();
		});

		// Initial focus on the primary (confirmatory) action — WCAG 2.4.3.
		// AppendPreviewModal is a confirmatory dialog, so focus lands on
		// the safe-by-default Append button. Destructive modals (see
		// ResetIndexConfirmModal) focus their Cancel button instead.
		confirmBtn.focus();
	}

	onClose(): void {
		this.lifecycle.unload();
		this.contentEl.empty();
	}

	private previewText(): string {
		return this.finalText();
	}

	private finalText(): string {
		if (!this.stripSources) return this.opts.replyText;
		// Strip from the first "Sources:" heading (any heading level
		// or plain bold "Sources:") to the end of the string.
		const re = /(^|\n)(#{1,6}\s+Sources:|\*\*Sources:\*\*|Sources:)\b[\s\S]*$/i;
		return this.opts.replyText.replace(re, '').trimEnd();
	}
}

function makeShortId(): string {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID().slice(0, 8);
	}
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}
