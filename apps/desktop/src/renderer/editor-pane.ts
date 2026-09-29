import {
  Component,
  joinPath,
  type LinkResolver,
  type TAbstractFile,
  type TFile,
  type Vault,
} from '@basalt/core';
import {
  createEditorState,
  EditorView,
  setLivePreview,
  type EditorHost,
  type EditorState,
} from '@basalt/editor';
import {
  normalizeHeading,
  parseSubpath,
  renderMarkdown,
  resolveSubpath,
  type RenderHost,
} from '@basalt/markdown';
import { setIcon } from '@basalt/ui';

/** Idle time after the last keystroke before the note is written to disk. */
export const AUTOSAVE_DELAY_MS = 2000;

const INVALID_NAME_CHARS = /[\\/:]/;

/** `live` and `source` are editing modes; `preview` is the reading view. */
export type ViewMode = 'live' | 'source' | 'preview';

export interface EditorPaneHandlers {
  /** Called when the open file changes (including to none). */
  onFileChange(file: TFile | null): void;
  /** Called on every document change of the open file. */
  onDocChange(text: string): void;
  onModeChange(mode: ViewMode): void;
  newNote(): void;
  /** Follows a link from `sourcePath` (a wikilink target or relative Markdown link). */
  openLink(linktext: string, sourcePath: string, newLeaf: boolean): void;
}

/**
 * Single Markdown leaf with Live Preview, source mode and the reading view. Owns
 * autosave: edits are written after AUTOSAVE_DELAY_MS of inactivity, and immediately when
 * switching files or closing.
 *
 * Editor states are kept per path for the session, so switching back to a note restores
 * its undo history, selection and scroll position.
 */
export class EditorPane extends Component {
  readonly containerEl: HTMLElement;
  private readonly breadcrumbEl: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly modeButton: HTMLElement;
  private readonly sourceEl: HTMLElement;
  private readonly readingEl: HTMLElement;
  private readonly sizerEl: HTMLElement;
  private readonly emptyEl: HTMLElement;
  private readonly view: EditorView;

  private file: TFile | null = null;
  private mode: ViewMode = 'live';
  private lastEditMode: 'live' | 'source' = 'live';
  private readonly states = new Map<string, EditorState>();
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saving: Promise<void> = Promise.resolve();
  private applyingExternal = false;
  private renderToken = 0;

  constructor(
    parentEl: HTMLElement,
    private readonly vault: Vault,
    private readonly resolver: LinkResolver,
    private readonly handlers: EditorPaneHandlers,
  ) {
    super();
    this.containerEl = parentEl.createDiv({
      cls: 'workspace-leaf-content',
      attr: { 'data-type': 'markdown', 'data-mode': 'source' },
    });
    const header = this.containerEl.createDiv('view-header');
    const titleContainer = header.createDiv('view-header-title-container');
    this.breadcrumbEl = titleContainer.createDiv('view-header-breadcrumb');
    this.titleEl = titleContainer.createDiv({
      cls: 'view-header-title',
      attr: { contenteditable: 'true', spellcheck: 'false' },
    });
    const actions = header.createDiv('view-actions');
    this.modeButton = actions.createDiv({ cls: 'clickable-icon view-action' });
    this.modeButton.addEventListener('click', () => this.toggleReading());

    const contentEl = this.containerEl.createDiv('view-content');
    this.sourceEl = contentEl.createDiv('markdown-source-view cm-s-obsidian mod-cm6');
    this.view = new EditorView({ parent: this.sourceEl, state: this.newState('', null) });
    this.readingEl = contentEl.createDiv('markdown-reading-view');
    const previewEl = this.readingEl.createDiv('markdown-preview-view markdown-rendered');
    this.sizerEl = previewEl.createDiv('markdown-preview-sizer markdown-preview-section');

    this.emptyEl = contentEl.createDiv('empty-state');
    const empty = this.emptyEl.createDiv('empty-state-container');
    empty.createDiv({ cls: 'empty-state-title', text: 'No file is open' });
    const action = empty.createDiv({ cls: 'empty-state-action', text: 'Create new note (Ctrl + N)' });
    action.addEventListener('click', () => this.handlers.newNote());
    this.showFile(null);
  }

  override onload(): void {
    this.registerEvent(this.vault.on('modify', (f: TAbstractFile) => void this.onExternalModify(f)));
    this.registerEvent(
      this.vault.on('delete', (f: TAbstractFile) => {
        this.states.delete(f.path);
        if (f === this.file) {
          this.clearSaveTimer();
          this.dirty = false;
          this.showFile(null);
        }
      }),
    );
    this.registerEvent(
      this.vault.on('rename', (f: TAbstractFile, oldPath: string) => {
        const state = this.states.get(oldPath);
        if (state) {
          this.states.delete(oldPath);
          this.states.set(f.path, state);
        }
        if (f === this.file) this.renderHeader();
      }),
    );

    this.registerDomEvent(this.titleEl, 'keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        this.focusContent();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        this.renderHeader();
        this.focusContent();
      }
    });
    this.registerDomEvent(this.titleEl, 'blur', () => void this.commitTitle());
    this.registerDomEvent(this.readingEl, 'click', (ev) => this.onReadingClick(ev));
    this.register(() => this.view.destroy());
  }

  getFile(): TFile | null {
    return this.file;
  }

  getText(): string {
    return this.view.state.doc.toString();
  }

  getMode(): ViewMode {
    return this.mode;
  }

  hasUnsavedChanges(): boolean {
    return this.dirty;
  }

  async openFile(file: TFile): Promise<void> {
    if (file === this.file) {
      this.focusContent();
      return;
    }
    await this.save();
    if (this.file) this.states.set(this.file.path, this.view.state);

    const text = await this.vault.read(file);
    const cached = this.states.get(file.path);
    this.view.setState(cached && cached.doc.toString() === text ? cached : this.newState(text, file));
    if (this.mode !== 'preview') setLivePreview(this.view, this.mode === 'live');
    this.showFile(file);
    this.focusContent();
  }

  // ---------------------------------------------------------------------------------------
  // Modes

  setMode(mode: ViewMode): void {
    if (mode !== 'preview') this.lastEditMode = mode;
    const changed = mode !== this.mode;
    this.mode = mode;
    if (mode !== 'preview') setLivePreview(this.view, mode === 'live');
    this.applyVisibility();
    if (mode === 'preview') void this.renderPreview();
    if (changed) this.handlers.onModeChange(mode);
  }

  /** Reading view ↔ the last editing mode (Ctrl/Cmd+E). */
  toggleReading(): void {
    this.setMode(this.mode === 'preview' ? this.lastEditMode : 'preview');
    this.focusContent();
  }

  /** Live Preview ↔ source mode. */
  toggleSourceMode(): void {
    this.setMode(this.lastEditMode === 'live' ? 'source' : 'live');
    this.focusContent();
  }

  /** Scrolls to `#Heading`, `#A#B` or `#^block` in the open note. */
  scrollToSubpath(subpath: string): void {
    const text = this.getText();
    const range = resolveSubpath(text, subpath);
    if (!range) return;
    if (this.mode === 'preview') {
      const { headings } = parseSubpath(subpath);
      const wanted = headings.length ? normalizeHeading(headings[headings.length - 1]!) : null;
      const target = wanted
        ? Array.from(this.sizerEl.querySelectorAll<HTMLElement>('[data-heading]')).find(
            (h) => normalizeHeading(h.dataset.heading ?? '') === wanted,
          )
        : null;
      target?.scrollIntoView({ block: 'start' });
      return;
    }
    this.view.dispatch({
      selection: { anchor: range.from },
      effects: EditorView.scrollIntoView(range.from, { y: 'start' }),
    });
    this.view.focus();
  }

  // ---------------------------------------------------------------------------------------
  // Saving

  /** Selects the title so the user can type a name, as after creating a note. */
  focusTitle(): void {
    this.titleEl.focus();
    const range = document.createRange();
    range.selectNodeContents(this.titleEl);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  }

  /** Writes pending changes now. Safe to call at any time. */
  save(): Promise<void> {
    this.clearSaveTimer();
    if (!this.dirty || !this.file) return this.saving;
    const file = this.file;
    const text = this.getText();
    this.dirty = false;
    this.saving = this.saving
      .then(() => this.vault.modify(file, text))
      .catch((err) => {
        console.error('Save failed', err);
        if (file === this.file) this.dirty = true;
      });
    return this.saving;
  }

  // ---------------------------------------------------------------------------------------
  // Internals

  private renderHost(): RenderHost {
    return {
      resolveLink: (linkpath, sourcePath) => this.resolver.getFirstLinkpathDest(linkpath, sourcePath),
      resourceUrl: (f) => this.vault.getResourcePath(f as TFile),
      readNote: (f) => this.vault.cachedRead(f as TFile),
    };
  }

  /** Link resolution for the editor, bound to the file (whose path follows renames). */
  private editorHost(file: TFile): EditorHost {
    const host = this.renderHost();
    return {
      resolveLink: (linkpath) => host.resolveLink(linkpath, file.path),
      resourceUrl: host.resourceUrl,
      openLink: (linktext, newLeaf) => this.handlers.openLink(linktext, file.path, newLeaf),
      renderMarkdown: (source, el) => renderMarkdown(source, el, { sourcePath: file.path, host }),
    };
  }

  private newState(doc: string, file: TFile | null): EditorState {
    return createEditorState({
      doc,
      onChange: (text) => this.onDocChanged(text),
      livePreview: this.lastEditMode === 'live',
      ...(file ? { host: this.editorHost(file) } : {}),
    });
  }

  private focusContent(): void {
    if (!this.file) return;
    if (this.mode === 'preview') this.readingEl.focus();
    else this.view.focus();
  }

  private async renderPreview(): Promise<void> {
    const file = this.file;
    const token = ++this.renderToken;
    if (!file) return;
    const staging = createDiv();
    await renderMarkdown(this.getText(), staging, { sourcePath: file.path, host: this.renderHost() });
    // Drop stale renders (the file or text changed while embeds were loading).
    if (token !== this.renderToken || file !== this.file) return;
    const scroll = this.readingEl.scrollTop;
    this.sizerEl.empty();
    while (staging.firstChild) this.sizerEl.appendChild(staging.firstChild);
    this.readingEl.scrollTop = scroll;
  }

  private onReadingClick(ev: MouseEvent): void {
    const target = ev.target as HTMLElement;
    const file = this.file;
    if (!file) return;
    const mod = ev.ctrlKey || ev.metaKey;

    const internal = target.closest<HTMLElement>('a.internal-link, .markdown-embed-link');
    if (internal) {
      ev.preventDefault();
      // Links inside an embedded note resolve relative to that note.
      const embed = internal
        .closest<HTMLElement>('.markdown-embed-content')
        ?.closest<HTMLElement>('[data-embed-path]');
      this.handlers.openLink(internal.dataset.href ?? '', embed?.dataset.embedPath ?? file.path, mod);
      return;
    }
    if (target.closest('a.tag')) {
      ev.preventDefault(); // Tag search arrives with the search view (Phase 4).
      return;
    }
    const footnote = target.closest<HTMLAnchorElement>('a.footnote-link');
    if (footnote) {
      ev.preventDefault();
      const id = footnote.getAttribute('href')?.slice(1);
      if (id) this.sizerEl.querySelector(`[id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'center' });
      return;
    }
    const box = target.closest<HTMLInputElement>('input.task-list-item-checkbox');
    if (box && !box.closest('.markdown-embed')) {
      ev.preventDefault();
      const line = Number(box.closest<HTMLElement>('[data-line]')?.dataset.line);
      if (Number.isFinite(line)) void this.toggleTask(file, line);
    }
  }

  /** Toggles the task on `line` (0-based) between open and done. */
  private async toggleTask(file: TFile, line: number): Promise<void> {
    await this.save();
    await this.vault.process(file, (text) => {
      const lines = text.split('\n');
      const current = lines[line];
      if (current === undefined) return text;
      lines[line] = current.replace(
        /^(\s*(?:[-*+]|\d+[.)])\s+\[)(.)(\])/,
        (_m, a: string, s: string, b: string) => `${a}${s === ' ' ? 'x' : ' '}${b}`,
      );
      return lines.join('\n');
    });
  }

  private onDocChanged(text: string): void {
    this.handlers.onDocChange(text);
    if (this.applyingExternal || !this.file) return;
    this.dirty = true;
    this.clearSaveTimer();
    this.saveTimer = setTimeout(() => void this.save(), AUTOSAVE_DELAY_MS);
  }

  private clearSaveTimer(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
  }

  /**
   * Reloads when the open file changed on disk, and refreshes the reading view when any
   * note changes (it may be embedded). Unsaved local edits win for now; a three-way merge
   * comes with file recovery in Phase 5.
   */
  private async onExternalModify(f: TAbstractFile): Promise<void> {
    if (f !== this.file) {
      if (this.mode === 'preview' && this.file) void this.renderPreview();
      return;
    }
    if (this.dirty) return;
    const text = await this.vault.read(this.file);
    if (f !== this.file || this.dirty) return;
    const current = this.getText();
    if (text !== current) {
      const head = Math.min(this.view.state.selection.main.head, text.length);
      this.applyingExternal = true;
      try {
        this.view.dispatch({
          changes: { from: 0, to: current.length, insert: text },
          selection: { anchor: head },
        });
      } finally {
        this.applyingExternal = false;
      }
    }
    if (this.mode === 'preview') void this.renderPreview();
  }

  private async commitTitle(): Promise<void> {
    const file = this.file;
    if (!file) return;
    const name = this.titleEl.getText().trim();
    if (!name || name === file.basename || INVALID_NAME_CHARS.test(name)) {
      this.renderHeader();
      return;
    }
    const ext = file.extension ? `.${file.extension}` : '';
    try {
      await this.vault.rename(file, joinPath(file.parent?.path ?? '/', name + ext));
    } catch (err) {
      console.error('Rename failed', err);
      this.renderHeader();
    }
  }

  private applyVisibility(): void {
    const hasFile = !!this.file;
    const reading = this.mode === 'preview';
    this.sourceEl.toggle(hasFile && !reading);
    this.readingEl.toggle(hasFile && reading);
    this.emptyEl.toggle(!hasFile);
    this.titleEl.toggle(hasFile);
    this.modeButton.toggle(hasFile);
    this.containerEl.setAttr('data-mode', reading ? 'preview' : 'source');
    setIcon(this.modeButton, reading ? 'pencil' : 'book-open');
    this.modeButton.setAttr(
      'aria-label',
      reading ? 'Current view: reading. Click to edit' : 'Current view: editing. Click to read',
    );
  }

  private showFile(file: TFile | null): void {
    this.file = file;
    this.renderToken++;
    if (!file) this.sizerEl.empty();
    this.applyVisibility();
    if (file && this.mode === 'preview') void this.renderPreview();
    this.renderHeader();
    this.handlers.onFileChange(file);
    this.handlers.onDocChange(file ? this.getText() : '');
  }

  private renderHeader(): void {
    this.breadcrumbEl.empty();
    const file = this.file;
    this.titleEl.setText(file?.basename ?? '');
    if (!file?.parent || file.parent.isRoot()) return;
    for (const segment of file.parent.path.split('/')) {
      this.breadcrumbEl.createSpan({ cls: 'view-header-breadcrumb-item', text: segment });
      this.breadcrumbEl.createSpan({ cls: 'view-header-breadcrumb-separator', text: '/' });
    }
  }
}
