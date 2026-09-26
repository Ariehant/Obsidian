import { Component, joinPath, TFile, TFolder, type TAbstractFile, type Vault } from '@basalt/core';
import { setIcon } from '@basalt/ui';

export interface FileExplorerHandlers {
  openFile(file: TFile): void;
  newNote(): void;
  newFolder(): void;
}

/** File names can't contain these on at least one supported platform. */
const INVALID_NAME_CHARS = /[\\/:]/;

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function sortChildren(children: TAbstractFile[]): TAbstractFile[] {
  return children.slice().sort((a, b) => {
    const aFolder = a instanceof TFolder;
    const bFolder = b instanceof TFolder;
    if (aFolder !== bFolder) return aFolder ? -1 : 1;
    return byName.compare(displayName(a), displayName(b));
  });
}

/** Markdown files show without their extension; other files show it as a tag. */
function displayName(file: TAbstractFile): string {
  return file instanceof TFile && file.extension === 'md' ? file.basename : file.name;
}

/**
 * Sidebar tree of the vault. Phase 0 re-renders the whole tree on structural changes; it
 * moves to incremental updates with the full workspace in Phase 3.
 */
export class FileExplorer extends Component {
  readonly containerEl: HTMLElement;
  private readonly filesEl: HTMLElement;
  private readonly expanded = new Set<string>();
  private activePath: string | null = null;
  private renderQueued = false;
  private renaming: string | null = null;

  constructor(
    parentEl: HTMLElement,
    private readonly vault: Vault,
    private readonly handlers: FileExplorerHandlers,
  ) {
    super();
    this.containerEl = parentEl.createDiv({
      cls: 'workspace-leaf-content',
      attr: { 'data-type': 'file-explorer' },
    });
    const header = this.containerEl.createDiv('nav-header');
    const buttons = header.createDiv('nav-buttons-container');
    this.addButton(buttons, 'square-pen', 'New note', () => this.handlers.newNote());
    this.addButton(buttons, 'folder-plus', 'New folder', () => this.handlers.newFolder());
    this.addButton(buttons, 'chevrons-down-up', 'Collapse all', () => {
      this.expanded.clear();
      this.render();
    });
    this.filesEl = this.containerEl.createDiv('nav-files-container');
  }

  override onload(): void {
    for (const name of ['create', 'delete'] as const) {
      this.registerEvent(this.vault.on(name, () => this.requestRender()));
    }
    this.registerEvent(
      this.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
        if (this.expanded.delete(oldPath)) this.expanded.add(file.path);
        if (this.activePath === oldPath) this.activePath = file.path;
        this.requestRender();
      }),
    );

    this.filesEl.on('click', '.nav-folder-title', (_ev, el) => {
      const folder = this.vault.getFolderByPath(el.dataset.path!);
      if (!folder || this.renaming === folder.path) return;
      const expand = !this.expanded.has(folder.path);
      if (expand) this.expanded.add(folder.path);
      else this.expanded.delete(folder.path);
      const itemEl = el.parentElement!;
      itemEl.toggleClass('is-collapsed', !expand);
      // Collapsed folders render their children lazily on first expand.
      const childrenEl = itemEl.querySelector<HTMLElement>(':scope > .tree-item-children')!;
      if (expand && !childrenEl.hasChildNodes()) this.renderChildren(childrenEl, folder);
    });
    this.filesEl.on('click', '.nav-file-title', (_ev, el) => {
      const file = this.vault.getFileByPath(el.dataset.path!);
      if (file && this.renaming !== file.path) this.handlers.openFile(file);
    });

    this.render();
  }

  setActiveFile(file: TFile | null): void {
    this.activePath = file?.path ?? null;
    // Reveal: expand every ancestor so the active file is visible.
    for (let p = file?.parent; p && !p.isRoot(); p = p.parent) this.expanded.add(p.path);
    this.render();
  }

  /** Expands the folder (if any) and starts inline renaming of the item at `path`. */
  startRename(path: string): void {
    const file = this.vault.getAbstractFileByPath(path);
    if (!file) return;
    if (file.parent && !file.parent.isRoot()) this.expanded.add(file.parent.path);
    this.render();

    const self = this.filesEl.querySelector<HTMLElement>(`.tree-item-self[data-path="${CSS.escape(path)}"]`);
    const inner = self?.querySelector<HTMLElement>('.tree-item-inner');
    if (!inner) return;

    this.renaming = path;
    inner.setAttr('contenteditable', 'true');
    inner.focus();
    const range = document.createRange();
    range.selectNodeContents(inner);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    let done = false;
    const finish = async (commit: boolean) => {
      if (done) return;
      done = true;
      this.renaming = null;
      inner.setAttr('contenteditable', null);
      const name = inner.getText().trim();
      if (commit && name && name !== displayName(file) && !INVALID_NAME_CHARS.test(name)) {
        const ext = file instanceof TFile && file.extension === 'md' ? '.md' : '';
        const target = joinPath(file.parent?.path ?? '/', name + ext);
        try {
          await this.vault.rename(file, target);
          return;
        } catch (err) {
          console.error('Rename failed', err);
        }
      }
      this.render();
    };
    inner.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        void finish(true);
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        void finish(false);
      }
    });
    inner.addEventListener('blur', () => void finish(true), { once: true });
  }

  private addButton(parent: HTMLElement, icon: string, label: string, onClick: () => void): void {
    const btn = parent.createDiv({ cls: 'clickable-icon nav-action-button', attr: { 'aria-label': label } });
    setIcon(btn, icon);
    btn.addEventListener('click', onClick);
  }

  private requestRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    queueMicrotask(() => {
      this.renderQueued = false;
      if (!this.renaming) this.render();
    });
  }

  private render(): void {
    const scroll = this.filesEl.scrollTop;
    this.filesEl.empty();
    const rootEl = this.filesEl.createDiv('tree-item nav-folder mod-root');
    this.renderChildren(rootEl.createDiv('tree-item-children nav-folder-children'), this.vault.getRoot());
    this.filesEl.scrollTop = scroll;
  }

  private renderChildren(parentEl: HTMLElement, folder: TFolder): void {
    for (const child of sortChildren(folder.children)) {
      if (child instanceof TFolder) this.renderFolder(parentEl, child);
      else if (child instanceof TFile) this.renderFile(parentEl, child);
    }
  }

  private renderFolder(parentEl: HTMLElement, folder: TFolder): void {
    const expanded = this.expanded.has(folder.path);
    const itemEl = parentEl.createDiv({ cls: ['tree-item', 'nav-folder'] });
    itemEl.toggleClass('is-collapsed', !expanded);
    const selfEl = itemEl.createDiv({
      cls: 'tree-item-self nav-folder-title is-clickable mod-collapsible',
      attr: { 'data-path': folder.path, draggable: 'true' },
    });
    setIcon(selfEl.createDiv('tree-item-icon collapse-icon'), 'chevron-right');
    selfEl.createDiv({ cls: 'tree-item-inner nav-folder-title-content', text: folder.name });
    const childrenEl = itemEl.createDiv('tree-item-children nav-folder-children');
    if (expanded) this.renderChildren(childrenEl, folder);
  }

  private renderFile(parentEl: HTMLElement, file: TFile): void {
    const itemEl = parentEl.createDiv('tree-item nav-file');
    const selfEl = itemEl.createDiv({
      cls: 'tree-item-self nav-file-title is-clickable',
      attr: { 'data-path': file.path, draggable: 'true' },
    });
    selfEl.toggleClass('is-active', file.path === this.activePath);
    selfEl.createDiv({ cls: 'tree-item-inner nav-file-title-content', text: displayName(file) });
    if (file.extension !== 'md') selfEl.createDiv({ cls: 'nav-file-tag', text: file.extension });
  }
}
