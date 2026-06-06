import { type App, normalizePath, Notice, TFolder } from 'obsidian';
import type { ChatSession } from '../chat/session';
import { sanitizeAssistantMarkdown } from '../chat/sanitize';
import type YunseulPlugin from '../main';

// Pure transform + side-effecting save of a ChatSession to Markdown.
// No DOM ownership; Notice + error logging are pushed to the orchestrator
// via the injected ClipboardAdapter so this module is unit-testable in
// isolation under JSDOM with a fake adapter.

/**
 * Adapter interface for clipboard writes. The orchestrator supplies an
 * implementation that wraps `navigator.clipboard.writeText` and surfaces
 * a Notice on success / a logger.error on failure. Tests pass a fake.
 */
export interface ClipboardAdapter {
	write(text: string): Promise<void>;
}

/**
 * Render a ChatSession to a Markdown document suitable for persisting
 * to the vault (Download) or copying to the clipboard (Copy all).
 *
 * Assistant content is sanitized before persistence so embeds
 * (`![[...]]`), data:-URI images, and external images are stripped /
 * blocked. External images are hard-blocked here regardless of the
 * in-chat allowExternalImages setting because the persisted note is
 * read outside Yunseul's render path.
 */
export function sessionToMarkdown(session: ChatSession): string {
	const lines: string[] = [];
	lines.push(`# Yunseul conversation`);
	lines.push('');
	lines.push(`Session: ${session.id}`);
	lines.push(`Created: ${new Date(session.createdAt).toISOString()}`);
	if (session.boundFile !== null) {
		lines.push(`Bound note: [[${session.boundFile.path}]]`);
	}
	lines.push('');
	for (const m of session.history) {
		lines.push(`## ${m.role}`);
		lines.push('');
		const content = m.role === 'assistant'
			? sanitizeAssistantMarkdown(m.content, { allowExternalImages: false })
			: m.content;
		lines.push(content);
		lines.push('');
	}
	return lines.join('\n');
}

/**
 * Format a timestamp for embedding in an export filename. Returns
 * "YYYY-MM-DD HH-MM-SS" using local time, padded.
 */
export function formatExportTimestamp(d: Date): string {
	const pad = (n: number, len = 2): string => String(n).padStart(len, '0');
	return (
		`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
		` ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
	);
}

/**
 * Copy the full conversation to the clipboard via the supplied adapter.
 */
export async function copyAll(
	session: ChatSession,
	clipboard: ClipboardAdapter,
): Promise<void> {
	const text = sessionToMarkdown(session);
	await clipboard.write(text);
}

// Maximum collision-suffix attempts. A rapid double-click or two
// concurrent sessions exporting in the same second land on the same
// timestamp; we walk -2, -3, ... up to this cap before surfacing a
// failure to the user. 99 is a generous ceiling for the only realistic
// collision pattern (per-second timestamps).
const FILENAME_COLLISION_LIMIT = 99;

/**
 * Pick the next free file path under `folderPath` for the given base
 * filename. Returns the base path if no conflict; otherwise appends
 * `-2`, `-3`, ..., up to FILENAME_COLLISION_LIMIT. Throws on overflow
 * (the caller's try/catch surfaces it to the logger).
 */
async function resolveFreeFilePath(
	app: App,
	folderPath: string,
	baseName: string,
	ext: string,
): Promise<string> {
	const adapter = app.vault.adapter;
	const basePath = normalizePath(`${folderPath}/${baseName}${ext}`);
	if (!(await adapter.exists(basePath))) return basePath;
	for (let i = 2; i <= FILENAME_COLLISION_LIMIT; i++) {
		const candidate = normalizePath(`${folderPath}/${baseName}-${i}${ext}`);
		if (!(await adapter.exists(candidate))) return candidate;
	}
	throw new Error(
		`Could not find a free filename under ${folderPath} after ${FILENAME_COLLISION_LIMIT} attempts.`,
	);
}

/**
 * Write the conversation to a new Markdown file under the configured
 * download folder. Creates the folder if it doesn't exist. Surfaces a
 * Notice on success and routes errors through the plugin logger.
 *
 * On filename collision (rapid double-click on Export, or two sessions
 * exporting in the same second) we append `-2`, `-3`, ... up to a cap
 * so the unhandled-throw from `vault.create` is replaced with a clean
 * fallback. The base filename retains its per-second timestamp because
 * that's still the most user-friendly anchor for sorting.
 */
export async function downloadConversation(
	app: App,
	plugin: YunseulPlugin,
	session: ChatSession,
): Promise<void> {
	try {
		const folder = plugin.settings.chat.downloadFolder.trim() || 'AI Chats';
		const folderPath = normalizePath(folder);
		const existing = app.vault.getAbstractFileByPath(folderPath);
		if (existing === null) {
			await app.vault.createFolder(folderPath);
		} else if (!(existing instanceof TFolder)) {
			throw new Error(`${folderPath} exists but is not a folder.`);
		}
		const ts = formatExportTimestamp(new Date());
		const filePath = await resolveFreeFilePath(app, folderPath, `Chat ${ts}`, '.md');
		const content = sessionToMarkdown(session);
		await app.vault.create(filePath, content);
		new Notice(`Saved ${filePath}`);
	} catch (e) {
		plugin.logger.error(
			`Download failed: ${e instanceof Error ? e.message : String(e)}`,
			'Could not save conversation.',
		);
	}
}
