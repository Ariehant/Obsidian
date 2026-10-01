import { Component, joinPath, TFile, TFolder, type TAbstractFile, type Vault } from '@basalt/core';
import { Menu, setIcon } from '@basalt/ui';

export interface FileExplorerHandlers {
  openFile(file: TFile): void;
  newNote(folder: TFolder): void;
  newFolder(folder: TFolder): void;
  /** Asks for confirmation, then trashes. */
  deleteFile(file: TAbstractFile): void;
  duplicate(file: TFile): void;
  revealInSystem(file: TAbstractFile): void;
  copyPath(file: TAbstractFile): void;
  /** Renames or moves, updating links. */
  renameFile(file: TAbstractFile, newPath: string): Promise<void>;
  /** Copies files dropped from the OS into a folder. */
  importFiles(folder: TFolder, files: File[]): Promise<void>;
}

/** File names can't contain these on at least one supported platform. */
const INVALID_NAME_CHARS = /[\\/:]/;
const DRAG_TYPE = 'application/x-basalt-path';

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function compareItems(a: TAbstractFile, b: TAbstractFile): number {
  const aFolder = a instanceof TFolder;
  const bFolder = b instanceof TFolder;
  if (aFolder !== bFolder) return aFolder ? -1 : 1;
  return byName.compare(displayName(a), displayName(b));
}

/** Markdown files show without their extension; other files show it as a tag. */
function displayName(file: TAbstractFile): string {
  return file instanceof TFile && file.extension === 'md' ? file.basename : file.name;
}

interface ItemDom {
  el: HTMLElement;
  selfEl: HTMLElement;
  innerEl: HTMLElement;
  /** Folders only. */
  childrenEl?: HTMLElement;
  /** Folders only: whether the children have been rendered (collapsed folders are lazy). */
  rendered?: boolean;
}

/**
 * Sidebar tree of the vault. The DOM is updated incrementally from vault events: each
 * entry owns one element, inserted at its sorted position, and collapsed folders render
 * their children on first expand.
 */
export class FileExplorer extends Component {
  readonly containerEl: HTMLElement;
  private readonly filesEl: HTMLElement;
  private readonly items = new Map<TAbstractFile, ItemDom>();
  private readonly expanded = new Set<string>();
  private active: TFile | null = null;
  private renaming: TAbstractFile | null = null;
  private dragged: TAbstractFile | null = null;
  private dropTarget: HTMLElement | null = null;

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
    this.addButton(buttons, 'square-pen', 'New note', () => this.handlers.newNote(this.vault.getRoot()));
    this.addButton(buttons, 'folder-plus', 'New folder', () => this.handlers.newFolder(this.vault.getRoot()));
    this.addButton(buttons, 'chevrons-down-up', 'Collapse all', () => this.collapseAll());
    this.filesEl = this.containerEl.createDiv('nav-files-container');
  }

  override onload(): void {
    const root = this.vault.getRoot();
    const rootEl = this.filesEl.createDiv('tree-item nav-folder mod-root');
    const selfEl = rootEl.createDiv({ cls: 'tree-item-self nav-folder-title', attr: { 'data-path': '/' } });
    selfEl.hide();
    const childrenEl = rootEl.createDiv('tree-item-children nav-folder-children');
    this.items.set(root, { el: rootEl, selfEl, innerEl: selfEl, childrenEl, rendered: true });
    this.renderChildren(root);

    this.registerEvent(this.vault.on('create', (f: TAbstractFile) => this.onCreate(f)));
    this.registerEvent(this.vault.on('delete', (f: TAbstractFile) => this.onDelete(f)));
    this.registerEvent(
      this.vault.on('rename', (f: TAbstractFile, oldPath: string) => this.onRename(f, oldPath)),
    );

    this.filesEl.on('click', '.nav-folder-title', (_ev, el) => {
      const folder = this.vault.getFolderByPath(el.dataset.path!);
      if (folder && this.renaming !== folder) this.setExpanded(folder, !this.expanded.has(folder.path));
    });
    this.filesEl.on('click', '.nav-file-title', (_ev, el) => {
      const file = this.vault.getFileByPath(el.dataset.path!);
      if (file && this.renaming !== file) this.handlers.openFile(file);
    });
    this.registerDomEvent(this.filesEl, 'contextmenu', (ev) => this.onContextMenu(ev));
    this.registerDragAndDrop();
  }

  setActiveFile(file: TFile | null): void {
    if (this.active) this.items.get(this.active)?.selfEl.removeClass('is-active');
    this.active = file;
    if (!file) return;
    this.reveal(file);
    const dom = this.items.get(file);
    dom?.selfEl.addClass('is-active');
    dom?.selfEl.scrollIntoView?.({ block: 'nearest' });
  }

  /** Expands every ancestor so `file` is visible. */
  reveal(file: TAbstractFile): void {
    const chain: TFolder[] = [];
    for (let p = file.parent; p && !p.isRoot(); p = p.parent) chain.unshift(p);
    for (const folder of chain) this.setExpanded(folder, true);
  }

  /** Starts inline renaming of `file`. */
  startRename(file: TAbstractFile): void {
    this.reveal(file);
    const dom = this.items.get(file);
    if (!dom) return;
    const inner = dom.innerEl;
    this.renaming = file;
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
        try {
          await this.handlers.renameFile(file, joinPath(file.parent?.path ?? '/', name + ext));
          return;
        } catch (err) {
          console.error('Rename failed', err);
        }
      }
      inner.setText(displayName(file));
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

  // ---------------------------------------------------------------------------------------
  // Rendering

  private addButton(parent: HTMLElement, icon: string, label: string, onClick: () => void): void {
    const btn = parent.createDiv({ cls: 'clickable-icon nav-action-button', attr: { 'aria-label': label } });
    setIcon(btn, icon);
    btn.addEventListener('click', onClick);
  }

  private collapseAll(): void {
    this.expanded.clear();
    for (const [file, dom] of this.items)
      if (file instanceof TFolder && !file.isRoot()) dom.el.addClass('is-collapsed');
  }

  private setExpanded(folder: TFolder, expand: boolean): void {
    const dom = this.items.get(folder);
    if (expand) this.expanded.add(folder.path);
    else this.expanded.delete(folder.path);
    if (!dom) return;
    dom.el.toggleClass('is-collapsed', !expand);
    if (expand && !dom.rendered) this.renderChildren(folder);
  }

  private renderChildren(folder: TFolder): void {
    const dom = this.items.get(folder)!;
    dom.rendered = true;
    for (const child of folder.children.slice().sort(compareItems)) {
      dom.childrenEl!.appendChild(this.createItem(child).el);
    }
  }

  private createItem(file: TAbstractFile): ItemDom {
    const isFolder = file instanceof TFolder;
    const el = createDiv({ cls: ['tree-item', isFolder ? 'nav-folder' : 'nav-file'] });
    const selfEl = el.createDiv({
      cls: isFolder
        ? 'tree-item-self nav-folder-title is-clickable mod-collapsible'
        : 'tree-item-self nav-file-title is-clickable',
      attr: { 'data-path': file.path, draggable: 'true' },
    });
    if (isFolder) setIcon(selfEl.createDiv('tree-item-icon collapse-icon'), 'chevron-right');
    const innerEl = selfEl.createDiv({
      cls: `tree-item-inner ${isFolder ? 'nav-folder-title-content' : 'nav-file-title-content'}`,
      text: displayName(file),
    });
    const dom: ItemDom = { el, selfEl, innerEl };
    if (file instanceof TFolder) {
      dom.childrenEl = el.createDiv('tree-item-children nav-folder-children');
      dom.rendered = false;
      this.items.set(file, dom);
      const expanded = this.expanded.has(file.path);
      el.toggleClass('is-collapsed', !expanded);
      if (expanded) this.renderChildren(file);
    } else {
      this.updateFileDecorations(file as TFile, dom);
      this.items.set(file, dom);
    }
    return dom;
  }

  private updateFileDecorations(file: TFile, dom: ItemDom): void {
    dom.selfEl.querySelector('.nav-file-tag')?.detach();
    if (file.extension !== 'md') dom.selfEl.createDiv({ cls: 'nav-file-tag', text: file.extension });
    dom.selfEl.toggleClass('is-active', file === this.active);
  }

  /** Inserts `file`'s element under its parent at its sorted position, if the parent is rendered. */
  private insert(file: TAbstractFile, dom: ItemDom): boolean {
    const parent = file.parent;
    const parentDom = parent ? this.items.get(parent) : undefined;
    if (!parent || !parentDom?.rendered || !parentDom.childrenEl) return false;
    const siblings = parent.children.filter((c) => c !== file).sort(compareItems);
    const next = siblings.find(
      (s) => compareItems(file, s) < 0 && this.items.get(s)?.el.parentElement === parentDom.childrenEl,
    );
    parentDom.childrenEl.insertBefore(dom.el, next ? this.items.get(next)!.el : null);
    return true;
  }

  private forget(dom: ItemDom): void {
    for (const [f, d] of this.items) if (d.el === dom.el || dom.el.contains(d.el)) this.items.delete(f);
  }

  private onCreate(file: TAbstractFile): void {
    if (this.items.has(file)) return;
    const parentDom = file.parent ? this.items.get(file.parent) : undefined;
    if (!parentDom?.rendered) return;
    const dom = this.createItem(file);
    if (!this.insert(file, dom)) this.forget(dom);
  }

  private onDelete(file: TAbstractFile): void {
    const dom = this.items.get(file);
    if (!dom) return;
    dom.el.detach();
    this.forget(dom);
    this.expanded.delete(file.path);
    if (file === this.active) this.active = null;
  }

  private onRename(file: TAbstractFile, oldPath: string): void {
    if (this.expanded.delete(oldPath)) this.expanded.add(file.path);
    const dom = this.items.get(file);
    if (!dom) {
      this.onCreate(file);
      return;
    }
    dom.selfEl.dataset.path = file.path;
    if (this.renaming !== file) dom.innerEl.setText(displayName(file));
    if (file instanceof TFile) this.updateFileDecorations(file, dom);
    dom.el.detach();
    if (!this.insert(file, dom)) this.forget(dom);
  }

  // ---------------------------------------------------------------------------------------
  // Context menu

  private fileAt(target: EventTarget | null): TAbstractFile | null {
    const self = (target as HTMLElement | null)?.closest<HTMLElement>('.tree-item-self');
    if (!self) return this.vault.getRoot();
    return this.vault.getAbstractFileByPath(self.dataset.path ?? '/');
  }

  private onContextMenu(ev: MouseEvent): void {
    const file = this.fileAt(ev.target);
    if (!file) return;
    ev.preventDefault();
    const menu = new Menu();
    const self = this.items.get(file)?.selfEl;
    if (self && !(file instanceof TFolder && file.isRoot())) {
      self.addClass('has-focus');
      menu.onHide(() => self.removeClass('has-focus'));
    }

    if (file instanceof TFolder) {
      menu.addItem((i) =>
        i
          .setSection('action-primary')
          .setTitle('New note')
          .setIcon('square-pen')
          .onClick(() => this.handlers.newNote(file)),
      );
      menu.addItem((i) =>
        i
          .setSection('action-primary')
          .setTitle('New folder')
          .setIcon('folder-plus')
          .onClick(() => this.handlers.newFolder(file)),
      );
    }
    if (!(file instanceof TFolder && file.isRoot())) {
      if (file instanceof TFile) {
        menu.addItem((i) =>
          i
            .setSection('action')
            .setTitle('Make a copy')
            .setIcon('files')
            .onClick(() => this.handlers.duplicate(file)),
        );
      }
      menu.addItem((i) =>
        i
          .setSection('action')
          .setTitle('Rename...')
          .setIcon('pencil')
          .onClick(() => this.startRename(file)),
      );
      menu.addItem((i) =>
        i
          .setSection('danger')
          .setTitle('Delete')
          .setIcon('trash-2')
          .setWarning(true)
          .onClick(() => this.handlers.deleteFile(file)),
      );
    }
    menu.addItem((i) =>
      i
        .setSection('info')
        .setTitle('Copy path')
        .setIcon('copy')
        .onClick(() => this.handlers.copyPath(file)),
    );
    menu.addItem((i) =>
      i
        .setSection('system')
        .setTitle('Reveal in system explorer')
        .setIcon('folder-open')
        .onClick(() => this.handlers.revealInSystem(file)),
    );
    menu.showAtMouseEvent(ev);
  }

  // ---------------------------------------------------------------------------------------
  // Drag and drop

  /** Folder a drop at `target` would move into, or null if `dragged` can't go there. */
  /** Folder under the pointer: the folder itself, or the parent of a file. */
  private folderAt(target: EventTarget | null): TFolder {
    const over = this.fileAt(target);
    return over instanceof TFolder ? over : (over?.parent ?? this.vault.getRoot());
  }

  private dropFolder(target: EventTarget | null): TFolder | null {
    const dragged = this.dragged;
    if (!dragged) return null;
    const folder = this.folderAt(target);
    if (folder === dragged.parent) return null;
    if (
      dragged instanceof TFolder &&
      (folder === dragged || (folder.path + '/').startsWith(dragged.path + '/'))
    ) {
      return null;
    }
    return folder;
  }

  private setDropTarget(folder: TFolder | null): void {
    const el = folder ? (folder.isRoot() ? this.filesEl : (this.items.get(folder)?.el ?? null)) : null;
    if (el === this.dropTarget) return;
    this.dropTarget?.removeClass('is-being-dragged-over');
    this.dropTarget = el;
    el?.addClass('is-being-dragged-over');
  }

  private registerDragAndDrop(): void {
    this.registerDomEvent(this.filesEl, 'dragstart', (ev) => {
      const file = this.fileAt(ev.target);
      if (!file || (file instanceof TFolder && file.isRoot()) || !ev.dataTransfer) return;
      this.dragged = file;
      ev.dataTransfer.effectAllowed = 'move';
      ev.dataTransfer.setData(DRAG_TYPE, file.path);
      ev.dataTransfer.setData('text/plain', file.path);
      this.items.get(file)?.selfEl.addClass('is-being-dragged');
    });
    this.registerDomEvent(this.filesEl, 'dragover', (ev) => {
      if (!this.dragged && ev.dataTransfer?.types.includes('Files')) {
        // Files dragged in from the OS: copy into the folder under the pointer.
        ev.preventDefault();
        ev.dataTransfer.dropEffect = 'copy';
        this.setDropTarget(this.folderAt(ev.target));
        return;
      }
      const folder = this.dropFolder(ev.target);
      this.setDropTarget(folder);
      if (folder && ev.dataTransfer) {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = 'move';
      }
    });
    this.registerDomEvent(this.filesEl, 'dragleave', (ev) => {
      if (!this.filesEl.contains(ev.relatedTarget as Node | null)) this.setDropTarget(null);
    });
    this.registerDomEvent(this.filesEl, 'drop', (ev) => {
      if (!this.dragged && ev.dataTransfer?.files.length) {
        ev.preventDefault();
        const target = this.folderAt(ev.target);
        this.setDropTarget(null);
        this.setExpanded(target, true);
        this.handlers
          .importFiles(target, Array.from(ev.dataTransfer.files))
          .catch((err) => console.error('Import failed', err));
        return;
      }
      const folder = this.dropFolder(ev.target);
      const dragged = this.dragged;
      this.setDropTarget(null);
      if (!folder || !dragged) return;
      ev.preventDefault();
      this.setExpanded(folder, true);
      this.handlers
        .renameFile(dragged, joinPath(folder.path, dragged.name))
        .catch((err) => console.error('Move failed', err));
    });
    this.registerDomEvent(this.filesEl, 'dragend', () => {
      if (this.dragged) this.items.get(this.dragged)?.selfEl.removeClass('is-being-dragged');
      this.dragged = null;
      this.setDropTarget(null);
    });
  }
}
