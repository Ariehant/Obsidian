import {
  App,
  Component,
  FileSystemAdapter,
  joinPath,
  TFolder,
  Vault,
  type TAbstractFile,
  type TFile,
} from '@basalt/core';
import { countWords } from '@basalt/editor';
import { parseLinktext } from '@basalt/markdown';
import { Notice, setIcon } from '@basalt/ui';
import { clipboard, ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc';
import { confirm } from './confirm-modal';
import { lazyMetadataStore } from './idb-store';
import { WorkerParser } from './worker-parser';
import { EditorPane, type ViewMode } from './editor-pane';
import { FileExplorer } from './file-explorer';

const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 600;

/** Picks "Untitled", "Untitled 1", … so the new path doesn't collide. */
function availablePath(vault: Vault, folder: string, base: string, ext: string): string {
  for (let i = 0; ; i++) {
    const path = joinPath(folder, `${base}${i ? ` ${i}` : ''}${ext}`);
    if (!vault.getAbstractFileByPath(path)) return path;
  }
}

const MODE_LABELS: Record<ViewMode, string> = {
  live: 'Live Preview',
  source: 'Source mode',
  preview: 'Reading',
};

/**
 * Window layout: ribbon, file explorer sidebar, one editor leaf, status bar.
 * The DOM mirrors the workspace structure themes expect; the real split/tab model
 * replaces this fixed layout in Phase 3.
 */
export class AppShell extends Component {
  readonly app: App;
  private readonly parser: WorkerParser;
  private readonly store: ReturnType<typeof lazyMetadataStore>;
  private explorer!: FileExplorer;
  private editor!: EditorPane;
  private wordCountEl!: HTMLElement;
  private charCountEl!: HTMLElement;
  private modeEl!: HTMLElement;

  constructor(
    private readonly rootEl: HTMLElement,
    vaultPath: string,
  ) {
    super();
    const adapter = new FileSystemAdapter(vaultPath, {
      trashItem: (fullPath) => ipcRenderer.invoke(IPC.trashItem, fullPath),
    });
    this.parser = new WorkerParser('metadata-worker.js');
    this.store = lazyMetadataStore(vaultPath);
    this.app = new App(new Vault(adapter), {
      parser: this.parser,
      store: this.store,
      fileManager: { confirmDeletion: (file) => this.confirmDeletion(file) },
    });
  }

  get vault(): Vault {
    return this.app.vault;
  }

  override onload(): void {
    document.title = `${this.vault.getName()} - Basalt`;
    this.buildLayout();
    this.register(() => {
      this.app.metadataCache.dispose();
      this.vault.close();
      this.parser.terminate();
      this.store.close();
    });
    this.vault
      .load()
      .then(() => this.app.metadataCache.initialize())
      .catch((err) => console.error('Failed to load vault', err));

    this.registerShortcuts();
    this.app.keymap.attach(window);
    this.register(() => this.app.keymap.dispose());
    this.registerDomEvent(window, 'beforeunload', (ev) => {
      // Closing with unsaved edits: cancel, flush to disk, then close for real.
      if (!this.editor.hasUnsavedChanges()) return;
      ev.preventDefault();
      ev.returnValue = false;
      void this.editor.save().finally(() => window.close());
    });
  }

  async createNote(folder: TFolder = this.vault.getRoot()): Promise<void> {
    const file = await this.vault.create(availablePath(this.vault, folder.path, 'Untitled', '.md'), '');
    await this.openFile(file);
    this.editor.focusTitle();
  }

  async createFolder(parent: TFolder = this.vault.getRoot()): Promise<void> {
    const folder = await this.vault.createFolder(availablePath(this.vault, parent.path, 'Untitled', ''));
    this.explorer.startRename(folder);
  }

  async deleteFile(file: TAbstractFile): Promise<void> {
    const isFolder = file instanceof TFolder;
    const open = this.editor.getFile();
    if (open === file || (isFolder && open?.path.startsWith(file.path + '/'))) await this.editor.save();
    try {
      await this.app.fileManager.promptForDeletion(file);
    } catch (err) {
      new Notice(`Could not delete "${file.name}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Renames or moves, rewriting links across the vault. Saves the open note first. */
  async renameFile(file: TAbstractFile, newPath: string): Promise<void> {
    await this.editor.save();
    try {
      await this.app.fileManager.renameFile(file, newPath);
    } catch (err) {
      new Notice(`Could not rename "${file.name}": ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  private confirmDeletion(file: TAbstractFile): Promise<boolean> {
    const isFolder = file instanceof TFolder;
    return confirm(this.app, {
      title: isFolder ? 'Delete folder' : 'Delete file',
      message: isFolder
        ? `Are you sure you want to delete "${file.name}" and everything in it? It will be moved to your system trash.`
        : `Are you sure you want to delete "${file.name}"? It will be moved to your system trash.`,
      confirmText: 'Delete',
      warning: true,
    });
  }

  async duplicate(file: TFile): Promise<void> {
    const ext = file.extension ? `.${file.extension}` : '';
    const copy = await this.vault.copy(
      file,
      availablePath(this.vault, file.parent?.path ?? '/', file.basename, ext),
    );
    if (copy.extension === 'md') await this.openFile(copy);
  }

  async openFile(file: TFile): Promise<void> {
    if (file.extension !== 'md') {
      // Image, PDF and other file views arrive with the workspace (Phase 3).
      await ipcRenderer.invoke(IPC.openPath, this.adapter.getFullPath(file.path));
      return;
    }
    await this.editor.openFile(file);
  }

  /**
   * Follows a link. An unresolved link creates the note, as clicking one does in the
   * reading view and Live Preview.
   */
  async openLinkText(linktext: string, sourcePath: string): Promise<void> {
    const { path, subpath } = parseLinktext(linktext);
    let file = path
      ? this.app.metadataCache.getFirstLinkpathDest(path, sourcePath)
      : this.vault.getFileByPath(sourcePath);
    if (!file && path) {
      if (path.split('/').some((seg) => seg === '..')) return;
      const target = /\.[^/.]+$/.test(path) ? path : `${path}.md`;
      file = await this.vault.create(target, '');
    }
    if (!file) return;
    await this.openFile(file);
    if (subpath && file.extension === 'md') this.editor.scrollToSubpath(subpath);
  }

  private get adapter(): FileSystemAdapter {
    return this.vault.adapter as FileSystemAdapter;
  }

  private buildLayout(): void {
    const container = this.rootEl.createDiv('app-container');
    const main = container.createDiv('horizontal-main-container');
    const workspace = main.createDiv('workspace');

    const ribbon = workspace.createDiv('workspace-ribbon side-dock-ribbon mod-left');
    const leftSplit = workspace.createDiv('workspace-split mod-horizontal mod-sidedock mod-left-split');
    const resizeHandle = workspace.createDiv('workspace-leaf-resize-handle');
    const rootSplit = workspace.createDiv('workspace-split mod-vertical mod-root');

    this.addRibbonAction(ribbon, 'panel-left', 'Toggle left sidebar', () => {
      const collapsed = !leftSplit.hasClass('is-collapsed');
      leftSplit.toggleClass('is-collapsed', collapsed);
      resizeHandle.toggle(!collapsed);
    });
    this.addRibbonAction(ribbon, 'square-pen', 'New note', () => void this.createNote());
    ribbon.createDiv({ attr: { style: 'flex: 1' } });
    this.addRibbonAction(ribbon, 'vault', 'Open another vault', () => void this.closeVault());

    this.explorer = this.addChild(
      new FileExplorer(leftSplit.createDiv('workspace-leaf'), this.vault, {
        openFile: (file) => void this.openFile(file),
        newNote: (folder) => void this.createNote(folder),
        newFolder: (folder) => void this.createFolder(folder),
        deleteFile: (file) => void this.deleteFile(file),
        duplicate: (file) => void this.duplicate(file),
        revealInSystem: (file) =>
          void ipcRenderer.invoke(IPC.showItemInFolder, this.adapter.getFullPath(file.path)),
        renameFile: (file, newPath) => this.renameFile(file, newPath),
        copyPath: (file) => {
          clipboard.writeText(file.path);
          new Notice('Path copied to clipboard', 2000);
        },
      }),
    );
    this.editor = this.addChild(
      new EditorPane(rootSplit.createDiv('workspace-leaf mod-active'), this.vault, this.app.linkResolver, {
        onFileChange: (file) => this.explorer?.setActiveFile(file),
        onDocChange: (text) => this.updateWordCount(text),
        onModeChange: (mode) => this.modeEl?.setText(MODE_LABELS[mode]),
        newNote: () => void this.createNote(),
        renameFile: (file, newPath) => this.renameFile(file, newPath),
        openLink: (linktext, sourcePath) =>
          void this.openLinkText(linktext, sourcePath).catch((err) =>
            console.error('Failed to open link', err),
          ),
      }),
    );

    const statusBar = container.createDiv('status-bar');
    this.modeEl = statusBar.createDiv({
      cls: 'status-bar-item mod-clickable plugin-editor-status',
      text: MODE_LABELS[this.editor.getMode()],
      attr: { 'aria-label': 'Toggle Live Preview/Source mode' },
    });
    this.modeEl.addEventListener('click', () => this.editor.toggleSourceMode());
    const counts = statusBar.createDiv('status-bar-item plugin-word-count');
    this.wordCountEl = counts.createSpan('status-bar-item-segment');
    this.charCountEl = counts.createSpan('status-bar-item-segment');
    this.updateWordCount(this.editor.getFile() ? this.editor.getText() : '');
    this.enableSidebarResize(resizeHandle, leftSplit);
  }

  private addRibbonAction(parent: HTMLElement, icon: string, label: string, onClick: () => void): void {
    const el = parent.createDiv({
      cls: 'side-dock-ribbon-action clickable-icon',
      attr: { 'aria-label': label },
    });
    setIcon(el, icon);
    el.addEventListener('click', onClick);
  }

  private enableSidebarResize(handle: HTMLElement, sidebar: HTMLElement): void {
    this.registerDomEvent(handle, 'pointerdown', (down) => {
      down.preventDefault();
      const startX = down.clientX;
      const startWidth = sidebar.getBoundingClientRect().width;
      handle.addClass('is-dragging');
      handle.setPointerCapture(down.pointerId);
      const move = (ev: PointerEvent) => {
        const width = Math.clamp(startWidth + ev.clientX - startX, SIDEBAR_MIN, SIDEBAR_MAX);
        sidebar.style.width = `${width}px`;
      };
      const up = () => {
        handle.removeClass('is-dragging');
        handle.removeEventListener('pointermove', move);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up, { once: true });
    });
  }

  private updateWordCount(text: string): void {
    if (!this.wordCountEl) return;
    const file = this.editor?.getFile();
    this.wordCountEl.setText(file ? `${countWords(text).toLocaleString()} words` : '');
    this.charCountEl.setText(file ? `${text.length.toLocaleString()} characters` : '');
    this.wordCountEl.closest<HTMLElement>('.status-bar')?.toggle(!!file);
  }

  /** App-wide shortcuts on the root scope; the command/hotkey system takes these over in Phase 4. */
  private registerShortcuts(): void {
    const scope = this.app.scope;
    scope.register(['Mod'], 'n', () => {
      void this.createNote();
      return false;
    });
    scope.register(['Mod', 'Shift'], 'n', () => {
      void this.createFolder();
      return false;
    });
    scope.register(['Mod'], 's', () => {
      void this.editor.save();
      return false;
    });
    scope.register(['Mod'], 'e', () => {
      this.editor.toggleReading();
      return false;
    });
  }

  private async closeVault(): Promise<void> {
    await this.editor.save();
    await ipcRenderer.invoke(IPC.vaultClose);
  }
}
