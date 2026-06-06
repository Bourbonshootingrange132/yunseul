import { type App, Notice, TFile } from 'obsidian';
import type { ChatSession } from '../chat/session';
import { sanitizeAssistantMarkdown } from '../chat/sanitize';
import type YunseulPlugin from '../main';
import { AppendPreviewModal } from './AppendPreviewModal';

// The Append-to-note modal flow (preview modal → write under H2
// 'Yunseul' → Notice). Pure function over (app, plugin, session, text).
// Sanitization runs BEFORE the preview modal so what the user reviews IS
// what hits disk; a second sanitize on the modal output is defense in
// depth in case a future modal lets the user edit the preview text.
// External images are hard-blocked regardless of the in-chat
// allowExternalImages setting because the persisted note is read
// outside Yunseul's render path.

export async function handleAppend(
	app: App,
	plugin: YunseulPlugin,
	session: ChatSession,
	text: string,
): Promise<void> {
	const file = session.boundFile;
	if (file === null) {
		new Notice('No bound note for this session yet.');
		return;
	}
	const af = app.vault.getAbstractFileByPath(file.path);
	if (!(af instanceof TFile) || af !== file) {
		new Notice('Bound note no longer exists.');
		session.boundFile = null;
		return;
	}
	const sanitized = sanitizeAssistantMarkdown(text, { allowExternalImages: false });
	new AppendPreviewModal(app, {
		file: af,
		replyText: sanitized,
		stripSources: false,
		onConfirm: (finalText) => {
			const recheck = app.vault.getAbstractFileByPath(af.path);
			if (!(recheck instanceof TFile) || recheck !== af) {
				new Notice('Bound note changed since the modal opened. Append aborted.');
				return;
			}
			const safeFinal = sanitizeAssistantMarkdown(finalText, {
				allowExternalImages: false,
			});
			void app.vault
				.process(recheck, (current) => `${current}\n\n${safeFinal}\n`)
				.then(() => new Notice(`Appended to ${recheck.path}`))
				.catch((e: unknown) => {
					const msg = e instanceof Error ? e.message : String(e);
					plugin.logger.error(`Append failed: ${msg}`, 'Append failed.');
				});
		},
	}).open();
}
