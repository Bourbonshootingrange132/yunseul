// Minimal Obsidian API stubs for vitest unit tests of pure modules.
// Only the symbols actually referenced from src/ that's covered by tests.
// UI/View modules historically were excluded from coverage; the V1.3
// AIChatView smoke test (tests/AIChatView.test.ts) brings them under
// jsdom by extending HTMLElement.prototype with Obsidian's createDiv /
// createEl / setText / addClass / etc. shims. The shims are guarded so
// they apply once per test process and do not affect non-UI tests.

export class Notice {
	constructor(_message: string, _timeout?: number) {}
	setMessage(_msg: string): this { return this; }
	hide(): void {}
	noticeEl: HTMLElement | undefined;
}

export function normalizePath(path: string): string {
	return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\//, '').replace(/\/$/, '');
}

// requestUrl shim. Tests that hit the LM Studio probe / listModels path
// inject a handler via `setRequestUrlHandler()`; otherwise the default
// returns a 404 so an accidentally-uninjected test fails loudly.
interface RequestUrlParam {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	throw?: boolean;
}
interface RequestUrlResponse {
	status: number;
	text: string;
	headers: Record<string, string>;
}
type RequestUrlHandler = (req: RequestUrlParam) => Promise<RequestUrlResponse> | RequestUrlResponse;

let __requestUrlHandler: RequestUrlHandler = (): RequestUrlResponse => ({
	status: 404,
	text: 'no requestUrl handler installed for test',
	headers: {},
});

export function setRequestUrlHandler(handler: RequestUrlHandler): void {
	__requestUrlHandler = handler;
}

export function resetRequestUrlHandler(): void {
	__requestUrlHandler = (): RequestUrlResponse => ({
		status: 404,
		text: 'no requestUrl handler installed for test',
		headers: {},
	});
}

export async function requestUrl(req: RequestUrlParam): Promise<RequestUrlResponse> {
	return Promise.resolve(__requestUrlHandler(req));
}

/**
 * Minimal stub. In production this is the desktop adapter whose
 * presence flags a real on-disk vault. Tests use it as a marker
 * superclass with `getBasePath()` so the claude-code provider's
 * `vaultBasePath()` helper resolves without hitting the real fs.
 */
export class FileSystemAdapter {
	private base: string;
	constructor(base = '/test/vault') {
		this.base = base;
	}
	getBasePath(): string {
		return this.base;
	}
}

export class TFile {
	path = '';
	name = '';
	basename = '';
	extension = '';
	stat = { ctime: 0, mtime: 0, size: 0 };
}

export interface CachedMetadata {
	frontmatter?: Record<string, unknown>;
	headings?: Array<{ heading: string; level: number; position: { start: { offset: number }; end: { offset: number } } }>;
	tags?: Array<{ tag: string; position: { start: { offset: number }; end: { offset: number } } }>;
}

export const Platform = {
	isMobile: false,
	isMobileApp: false,
	isDesktop: true,
	isMacOS: false,
};

// ============================================================================
// UI-test additions (V1.3 AIChatView smoke test).
//
// Everything below is loaded once per test process. Non-UI tests never
// touch HTMLElement.createDiv etc., so the prototype augmentation is
// inert for them.
// ============================================================================

interface ElOpts {
	cls?: string;
	text?: string;
	attr?: Record<string, string>;
}

function applyOpts(el: HTMLElement, opts: ElOpts | undefined): void {
	if (opts === undefined) return;
	if (opts.cls !== undefined) el.className = opts.cls;
	if (opts.text !== undefined) el.textContent = opts.text;
	if (opts.attr !== undefined) {
		for (const [k, v] of Object.entries(opts.attr)) el.setAttribute(k, v);
	}
}

// Polyfill Obsidian's HTMLElement augmentations onto jsdom's prototype.
// Guarded so re-import doesn't double-patch.
type ElProtoExt = {
	createDiv: (opts?: ElOpts) => HTMLDivElement;
	createEl: <K extends keyof HTMLElementTagNameMap>(tag: K, opts?: ElOpts) => HTMLElementTagNameMap[K];
	createSpan: (opts?: ElOpts) => HTMLSpanElement;
	empty: () => void;
	setText: (s: string) => void;
	setAttr: (k: string, v: string) => void;
	addClass: (...cls: string[]) => void;
	removeClass: (...cls: string[]) => void;
	toggleClass: (cls: string, on?: boolean) => void;
	hasClass: (cls: string) => boolean;
	hide: () => void;
	show: () => void;
	setCssStyles: (styles: Record<string, string>) => void;
};

const protoAny = HTMLElement.prototype as unknown as Partial<ElProtoExt> & HTMLElement;
if (protoAny.createDiv === undefined) {
	protoAny.createDiv = function (this: HTMLElement, opts?: ElOpts): HTMLDivElement {
		const el = this.ownerDocument.createElement('div');
		applyOpts(el, opts);
		this.appendChild(el);
		return el;
	};
	protoAny.createEl = function <K extends keyof HTMLElementTagNameMap>(
		this: HTMLElement, tag: K, opts?: ElOpts,
	): HTMLElementTagNameMap[K] {
		const el = this.ownerDocument.createElement(tag);
		applyOpts(el as HTMLElement, opts);
		this.appendChild(el);
		return el;
	};
	protoAny.createSpan = function (this: HTMLElement, opts?: ElOpts): HTMLSpanElement {
		const el = this.ownerDocument.createElement('span');
		applyOpts(el, opts);
		this.appendChild(el);
		return el;
	};
	protoAny.empty = function (this: HTMLElement): void {
		while (this.firstChild !== null) this.removeChild(this.firstChild);
	};
	protoAny.setText = function (this: HTMLElement, s: string): void {
		this.textContent = s;
	};
	protoAny.setAttr = function (this: HTMLElement, k: string, v: string): void {
		this.setAttribute(k, v);
	};
	protoAny.addClass = function (this: HTMLElement, ...cls: string[]): void {
		this.classList.add(...cls);
	};
	protoAny.removeClass = function (this: HTMLElement, ...cls: string[]): void {
		this.classList.remove(...cls);
	};
	protoAny.toggleClass = function (this: HTMLElement, cls: string, on?: boolean): void {
		this.classList.toggle(cls, on);
	};
	protoAny.hasClass = function (this: HTMLElement, cls: string): boolean {
		return this.classList.contains(cls);
	};
	protoAny.hide = function (this: HTMLElement): void {
		this.style.display = 'none';
	};
	protoAny.show = function (this: HTMLElement): void {
		this.style.display = '';
	};
	protoAny.setCssStyles = function (this: HTMLElement, styles: Record<string, string>): void {
		for (const [k, v] of Object.entries(styles)) {
			(this.style as unknown as Record<string, string>)[k] = v;
		}
	};
}

// Obsidian exposes `activeDocument` as a global on window. AIChatView
// and ChatHeader reach for it directly.
if (typeof globalThis !== 'undefined' && (globalThis as { activeDocument?: Document }).activeDocument === undefined) {
	(globalThis as { activeDocument: Document }).activeDocument = document;
}

// jsdom doesn't ship matchMedia. AIChatView subscribes to the
// prefers-reduced-motion query in onOpen.
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
	(window as Window & { matchMedia: (q: string) => MediaQueryList }).matchMedia = (
		_q: string,
	): MediaQueryList => ({
		matches: false,
		media: _q,
		onchange: null,
		addEventListener: (): void => {},
		removeEventListener: (): void => {},
		addListener: (): void => {},
		removeListener: (): void => {},
		dispatchEvent: (): boolean => false,
	}) as unknown as MediaQueryList;
}

// jsdom's Element doesn't implement scrollTo / scrollIntoView. AIChatView
// calls transcriptEl.scrollTo to keep the latest bubble in view.
if (typeof Element !== 'undefined' && typeof Element.prototype.scrollTo !== 'function') {
	(Element.prototype as Element & { scrollTo: (...a: unknown[]) => void }).scrollTo = (): void => {};
}

export function setIcon(_el: HTMLElement, _name: string): void {
	// no-op — icons aren't asserted in unit tests
}

export function addIcon(_name: string, _svg: string): void {
	// no-op
}

export type IconName = string;

/**
 * Stub Component — captures registered intervals (so tests can flush
 * vi.getTimerCount() after onClose) and tracks listeners just enough that
 * dispatching events from the test exercises real handlers.
 */
export class Component {
	private _children: Component[] = [];
	private _intervals: number[] = [];
	load(): void {}
	unload(): void {
		for (const id of this._intervals) {
			clearInterval(id);
		}
		this._intervals = [];
		for (const c of this._children) c.unload();
		this._children = [];
	}
	addChild<C extends Component>(c: C): C { this._children.push(c); return c; }
	registerDomEvent<K extends keyof HTMLElementEventMap>(
		el: HTMLElement,
		evt: K,
		handler: (ev: HTMLElementEventMap[K]) => unknown,
	): void {
		el.addEventListener(evt, handler as EventListener);
	}
	registerInterval(id: number): number {
		this._intervals.push(id);
		return id;
	}
	registerEvent(_eventRef: unknown): void {}
}

export interface WorkspaceLeaf {
	view: unknown;
}

/**
 * ItemView stub: extends Component so register* helpers exist. Provides
 * the containerEl/contentEl pair that the orchestrator paints into. `app`
 * is read off the leaf so tests can pass their own stubbed App.
 */
export class ItemView extends Component {
	containerEl: HTMLElement;
	contentEl: HTMLElement;
	app: unknown;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	leaf: any;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	constructor(leaf: any) {
		super();
		this.leaf = leaf;
		this.app = leaf?.app;
		this.containerEl = document.createElement('div');
		this.contentEl = this.containerEl;
	}
	getViewType(): string { return ''; }
	getDisplayText(): string { return ''; }
	getIcon(): string { return ''; }
}

/** Stub Modal — only imported, never opened, in the AIChatView tests. */
export class Modal {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	app: any;
	contentEl: HTMLElement;
	titleEl: HTMLElement;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	constructor(app: any) {
		this.app = app;
		this.contentEl = document.createElement('div');
		this.titleEl = document.createElement('div');
	}
	open(): void {}
	close(): void {}
	// Obsidian's Modal.setTitle replaces titleEl text — mirror that
	// shape so call sites (AppendPreviewModal, IndexPromptModal,
	// ResetIndexConfirmModal) type-check and runtime-succeed under jsdom.
	setTitle(text: string): void {
		this.titleEl.textContent = text;
	}
}

/** Stub Menu — ChatHeader's `…` menu is imported but not opened in tests. */
export class Menu {
	addItem(_cb: (i: { setTitle: (t: string) => unknown; onClick: (cb: () => void) => unknown }) => void): this { return this; }
	onHide(_cb: () => void): this { return this; }
	showAtPosition(_p: { x: number; y: number }): this { return this; }
	showAtMouseEvent(_ev: MouseEvent): this { return this; }
}

/**
 * MarkdownRenderer stub: drops a div with class `markdown-rendered` so
 * tests can distinguish the final-render phase from the cheap streaming
 * Text-node phase. The body text is set as textContent so assertions on
 * the rendered string still work.
 */
export const MarkdownRenderer = {
	render: async (
		_app: unknown,
		markdown: string,
		el: HTMLElement,
		_sourcePath: string,
		_component: unknown,
	): Promise<void> => {
		const rendered = el.ownerDocument.createElement('div');
		rendered.className = 'markdown-rendered';
		rendered.textContent = markdown;
		el.appendChild(rendered);
	},
};

// PluginSettingTab / Setting / Plugin — only imported transitively (via
// settings.ts) when AIChatView's transitive deps reach main.ts. We don't
// import main.ts in the test, so these classes need to exist only as
// type targets. Define them as empty classes; the tests never call them.
export class PluginSettingTab {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	constructor(_app: any, _plugin: any) {}
	display(): void {}
}
export class Setting {
	settingEl: HTMLElement = document.createElement('div');
	constructor(_el: HTMLElement) {}
	setName(_n: string): this { return this; }
	setDesc(_d: string): this { return this; }
	setHeading(): this { return this; }
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	addText(_cb: (t: any) => void): this { return this; }
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	addToggle(_cb: (t: any) => void): this { return this; }
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	addSlider(_cb: (t: any) => void): this { return this; }
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	addButton(_cb: (t: any) => void): this { return this; }
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	addDropdown(_cb: (t: any) => void): this { return this; }
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	addExtraButton(_cb: (t: any) => void): this { return this; }
}
export class Plugin {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	app: any;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	manifest: any;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	constructor(app: any, manifest: any) {
		this.app = app;
		this.manifest = manifest;
	}
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	loadData(): Promise<any> { return Promise.resolve({}); }
	saveData(_d: unknown): Promise<void> { return Promise.resolve(); }
	addCommand(_c: unknown): void {}
	addRibbonIcon(_i: string, _t: string, _cb: () => void): HTMLElement { return document.createElement('div'); }
	addSettingTab(_t: unknown): void {}
	registerView(_t: string, _cb: unknown): void {}
	registerEvent(_e: unknown): void {}
}

export class TFolder {
	path = '';
	name = '';
}

export type TAbstractFile = TFile | TFolder;

// no-op default export so `import 'obsidian'` doesn't fail
export default {};
