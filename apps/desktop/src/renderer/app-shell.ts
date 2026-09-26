import { App, Component, FileSystemAdapter, joinPath, Vault, type TFile } from '@basalt/core';
import { countWords } from '@basalt/editor';
import { setIcon } from '@basalt/ui';
import { ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc';
import { EditorPane } from './editor-pane';
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

/**
 * Phase 0 window layout: ribbon, file explorer sidebar, one editor leaf, status bar.
 * The DOM mirrors the workspace structure themes expect; the real split/tab model
 * replaces this fixed layout in Phase 3.
 */
export class AppShell extends Component {
  readonly app: App;
  private explorer!: FileExplorer;
  private editor!: EditorPane;
  private wordCountEl!: HTMLElement;
  private charCountEl!: HTMLElement;

  constructor(
    private readonly rootEl: HTMLElement,
    vaultPath: string,
  ) {
    super();
    const adapter = new FileSystemAdapter(vaultPath, {
      trashItem: (fullPath) => ipcRenderer.invoke(IPC.trashItem, fullPath),
    });
    this.app = new App(new Vault(adapter));
  }

  get vault(): Vault {
    return this.app.vault;
  }

  override onload(): void {
    document.title = `${this.vault.getName()} - Basalt`;
    this.buildLayout();
    this.register(() => this.vault.close());
    this.vault.load().catch((err) => console.error('Failed to load vault', err));

    this.registerDomEvent(document, 'keydown', (ev) => this.onKeyDown(ev));
    this.registerDomEvent(window, 'beforeunload', (ev) => {
      // Closing with unsaved edits: cancel, flush to disk, then close for real.
      if (!this.editor.hasUnsavedChanges()) return;
      ev.preventDefault();
      ev.returnValue = false;
      void this.editor.save().finally(() => window.close());
    });
  }

  async createNote(): Promise<void> {
    const file = await this.vault.create(availablePath(this.vault, '/', 'Untitled', '.md'), '');
    await this.openFile(file);
    this.editor.focusTitle();
  }

  async createFolder(): Promise<void> {
    const folder = await this.vault.createFolder(availablePath(this.vault, '/', 'Untitled', ''));
    this.explorer.startRename(folder.path);
  }

  async openFile(file: TFile): Promise<void> {
    await this.editor.openFile(file);
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
        newNote: () => void this.createNote(),
        newFolder: () => void this.createFolder(),
      }),
    );
    this.editor = this.addChild(
      new EditorPane(rootSplit.createDiv('workspace-leaf mod-active'), this.vault, {
        onFileChange: (file) => this.explorer?.setActiveFile(file),
        onDocChange: (text) => this.updateWordCount(text),
        newNote: () => void this.createNote(),
      }),
    );

    const statusBar = container.createDiv('status-bar');
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

  /** Phase 0 hard-coded shortcuts; the command/hotkey system replaces these in Phase 4. */
  private onKeyDown(ev: KeyboardEvent): void {
    const mod = process.platform === 'darwin' ? ev.metaKey : ev.ctrlKey;
    if (!mod || ev.altKey) return;
    const key = ev.key.toLowerCase();
    if (key === 'n' && !ev.shiftKey) {
      ev.preventDefault();
      void this.createNote();
    } else if (key === 'n' && ev.shiftKey) {
      ev.preventDefault();
      void this.createFolder();
    } else if (key === 's') {
      ev.preventDefault();
      void this.editor.save();
    }
  }

  private async closeVault(): Promise<void> {
    await this.editor.save();
    await ipcRenderer.invoke(IPC.vaultClose);
  }
}
