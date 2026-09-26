import { Component, joinPath, type TAbstractFile, type TFile, type Vault } from '@basalt/core';
import { createEditorState, EditorView, type EditorState } from '@basalt/editor';

/** Idle time after the last keystroke before the note is written to disk. */
export const AUTOSAVE_DELAY_MS = 2000;

const INVALID_NAME_CHARS = /[\\/:]/;

export interface EditorPaneHandlers {
  /** Called when the open file changes (including to none). */
  onFileChange(file: TFile | null): void;
  /** Called on every document change of the open file. */
  onDocChange(text: string): void;
  newNote(): void;
}

/**
 * Single Markdown editor leaf (source mode). Owns autosave: edits are written after
 * AUTOSAVE_DELAY_MS of inactivity, and immediately when switching files or closing.
 *
 * Editor states are kept per path for the session, so switching back to a note restores
 * its undo history, selection and scroll position.
 */
export class EditorPane extends Component {
  readonly containerEl: HTMLElement;
  private readonly breadcrumbEl: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly contentEl: HTMLElement;
  private readonly sourceEl: HTMLElement;
  private readonly emptyEl: HTMLElement;
  private readonly view: EditorView;

  private file: TFile | null = null;
  private readonly states = new Map<string, EditorState>();
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saving: Promise<void> = Promise.resolve();
  private applyingExternal = false;

  constructor(
    parentEl: HTMLElement,
    private readonly vault: Vault,
    private readonly handlers: EditorPaneHandlers,
  ) {
    super();
    this.containerEl = parentEl.createDiv({
      cls: 'workspace-leaf-content',
      attr: { 'data-type': 'markdown' },
    });
    const header = this.containerEl.createDiv('view-header');
    const titleContainer = header.createDiv('view-header-title-container');
    this.breadcrumbEl = titleContainer.createDiv('view-header-breadcrumb');
    this.titleEl = titleContainer.createDiv({
      cls: 'view-header-title',
      attr: { contenteditable: 'true', spellcheck: 'false' },
    });
    this.contentEl = this.containerEl.createDiv('view-content');
    this.sourceEl = this.contentEl.createDiv('markdown-source-view cm-s-obsidian mod-cm6');
    this.view = new EditorView({ parent: this.sourceEl, state: this.newState('') });

    this.emptyEl = this.contentEl.createDiv('empty-state');
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
        this.view.focus();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        this.renderHeader();
        this.view.focus();
      }
    });
    this.registerDomEvent(this.titleEl, 'blur', () => void this.commitTitle());
    this.register(() => this.view.destroy());
  }

  getFile(): TFile | null {
    return this.file;
  }

  getText(): string {
    return this.view.state.doc.toString();
  }

  hasUnsavedChanges(): boolean {
    return this.dirty;
  }

  async openFile(file: TFile): Promise<void> {
    if (file === this.file) {
      this.view.focus();
      return;
    }
    await this.save();
    if (this.file) this.states.set(this.file.path, this.view.state);

    const text = await this.vault.read(file);
    const cached = this.states.get(file.path);
    this.view.setState(cached && cached.doc.toString() === text ? cached : this.newState(text));
    this.showFile(file);
    this.view.focus();
  }

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

  private newState(doc: string): EditorState {
    return createEditorState({ doc, onChange: (text) => this.onDocChanged(text) });
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
   * Reloads the editor when the open file changed on disk. Unsaved local edits win for now;
   * a three-way merge comes with file recovery in Phase 5.
   */
  private async onExternalModify(f: TAbstractFile): Promise<void> {
    if (f !== this.file || this.dirty) return;
    const text = await this.vault.read(this.file);
    if (f !== this.file || this.dirty) return;
    const current = this.getText();
    if (text === current) return;

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

  private showFile(file: TFile | null): void {
    this.file = file;
    this.sourceEl.toggle(!!file);
    this.emptyEl.toggle(!file);
    this.titleEl.toggle(!!file);
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
