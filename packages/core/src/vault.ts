import { isWatchable, type DataAdapter, type DataWriteOptions, type Stat } from './adapter';
import { Events, type EventRef } from './events';
import { setFilePath, TAbstractFile, TFile, TFolder, type FileStats } from './files';
import { isHiddenPath, normalizePath, parentPath } from './path';
import { SerialQueue } from './serial-queue';

/** Delay used to coalesce bursts of watcher notifications. */
const WATCH_DEBOUNCE_MS = 50;

/**
 * In-memory model of the files in a vault, kept in sync with the adapter.
 *
 * Every mutation, whether it comes from the API or from the adapter's watcher, runs through
 * one serial queue. That means our own writes are always reflected in the tree before the
 * watcher's echo of them is reconciled, so the echo is recognised as a no-op.
 *
 * Hidden entries (any dot-prefixed path segment, which includes the config folder) are not
 * part of the tree. Changes to them are still reported through the `raw` event.
 */
export class Vault extends Events {
  adapter: DataAdapter;
  configDir = '.obsidian';

  private readonly root: TFolder;
  private fileMap: Record<string, TAbstractFile> = {};
  private readonly contentCache = new Map<string, { mtime: number; data: string }>();
  private readonly queue = new SerialQueue();
  private stopWatching: (() => void) | null = null;
  private pendingPaths = new Set<string>();
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(adapter: DataAdapter) {
    super();
    this.adapter = adapter;
    this.root = new TFolder(this, '/');
    this.fileMap['/'] = this.root;
  }

  // ---------------------------------------------------------------------------------------
  // Lifecycle (host API, not part of the plugin API)

  /** Scans the vault, firing `create` for every entry, then starts watching for changes. */
  async load(): Promise<void> {
    await this.queue.run(() => this.scanFolder(this.root));
    if (isWatchable(this.adapter)) {
      this.stopWatching = this.adapter.watch((path) => this.onWatchEvent(path));
    }
  }

  /** Stops watching. Pending external changes are dropped. */
  close(): void {
    this.stopWatching?.();
    this.stopWatching = null;
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
    this.pendingPaths.clear();
    this.trigger('closed');
  }

  /** Resolves once queued mutations and debounced watcher events have been processed. */
  async whenIdle(): Promise<void> {
    if (this.pendingTimer) this.flushWatchEvents();
    await this.queue.idle();
  }

  // ---------------------------------------------------------------------------------------
  // Events

  override on(name: 'create', callback: (file: TAbstractFile) => any, ctx?: any): EventRef;
  override on(name: 'modify', callback: (file: TAbstractFile) => any, ctx?: any): EventRef;
  override on(name: 'delete', callback: (file: TAbstractFile) => any, ctx?: any): EventRef;
  override on(name: 'rename', callback: (file: TAbstractFile, oldPath: string) => any, ctx?: any): EventRef;
  override on(name: 'raw', callback: (path: string) => any, ctx?: any): EventRef;
  override on(name: 'closed', callback: () => any, ctx?: any): EventRef;
  override on(name: string, callback: (...data: any[]) => any, ctx?: any): EventRef;
  override on(name: string, callback: (...data: any[]) => any, ctx?: any): EventRef {
    return super.on(name, callback, ctx);
  }

  // ---------------------------------------------------------------------------------------
  // Lookup

  getName(): string {
    return this.adapter.getName();
  }

  getRoot(): TFolder {
    return this.root;
  }

  getAbstractFileByPath(path: string): TAbstractFile | null {
    return this.fileMap[normalizePath(path)] ?? null;
  }

  getFileByPath(path: string): TFile | null {
    const f = this.getAbstractFileByPath(path);
    return f instanceof TFile ? f : null;
  }

  getFolderByPath(path: string): TFolder | null {
    const f = this.getAbstractFileByPath(path);
    return f instanceof TFolder ? f : null;
  }

  getAllLoadedFiles(): TAbstractFile[] {
    return Object.values(this.fileMap);
  }

  getAllFolders(includeRoot?: boolean): TFolder[] {
    return Object.values(this.fileMap).filter(
      (f): f is TFolder => f instanceof TFolder && (includeRoot || !f.isRoot()),
    );
  }

  getFiles(): TFile[] {
    return Object.values(this.fileMap).filter((f): f is TFile => f instanceof TFile);
  }

  getMarkdownFiles(): TFile[] {
    return this.getFiles().filter((f) => f.extension === 'md');
  }

  static recurseChildren(root: TFolder, cb: (file: TAbstractFile) => any): void {
    cb(root);
    for (const child of root.children.slice()) {
      if (child instanceof TFolder) Vault.recurseChildren(child, cb);
      else cb(child);
    }
  }

  getResourcePath(file: TFile): string {
    return `${this.adapter.getResourcePath(file.path)}?${file.stat.mtime}`;
  }

  // ---------------------------------------------------------------------------------------
  // Reading

  async read(file: TFile): Promise<string> {
    const data = await this.adapter.read(file.path);
    this.contentCache.set(file.path, { mtime: file.stat.mtime, data });
    return data;
  }

  async cachedRead(file: TFile): Promise<string> {
    const cached = this.contentCache.get(file.path);
    if (cached && cached.mtime === file.stat.mtime) return cached.data;
    return this.read(file);
  }

  readBinary(file: TFile): Promise<ArrayBuffer> {
    return this.adapter.readBinary(file.path);
  }

  // ---------------------------------------------------------------------------------------
  // Mutations

  create(path: string, data: string, options?: DataWriteOptions): Promise<TFile> {
    return this.queue.run(async () => {
      const p = await this.prepareCreate(path);
      await this.adapter.write(p, data, options);
      const file = await this.addFileFromDisk(p);
      this.contentCache.set(p, { mtime: file.stat.mtime, data });
      return file;
    });
  }

  createBinary(path: string, data: ArrayBuffer, options?: DataWriteOptions): Promise<TFile> {
    return this.queue.run(async () => {
      const p = await this.prepareCreate(path);
      await this.adapter.writeBinary(p, data, options);
      return this.addFileFromDisk(p);
    });
  }

  createFolder(path: string): Promise<TFolder> {
    return this.queue.run(async () => {
      const p = normalizePath(path);
      if (this.fileMap[p] || (await this.adapter.exists(p))) throw new Error('Folder already exists.');
      await this.adapter.mkdir(p);
      return this.ensureFolderInTree(p);
    });
  }

  modify(file: TFile, data: string, options?: DataWriteOptions): Promise<void> {
    return this.queue.run(async () => {
      await this.adapter.write(file.path, data, options);
      await this.afterWrite(file, data);
    });
  }

  modifyBinary(file: TFile, data: ArrayBuffer, options?: DataWriteOptions): Promise<void> {
    return this.queue.run(async () => {
      await this.adapter.writeBinary(file.path, data, options);
      await this.afterWrite(file, null);
    });
  }

  append(file: TFile, data: string, options?: DataWriteOptions): Promise<void> {
    return this.queue.run(async () => {
      await this.adapter.append(file.path, data, options);
      await this.afterWrite(file, null);
    });
  }

  appendBinary(file: TFile, data: ArrayBuffer, options?: DataWriteOptions): Promise<void> {
    return this.queue.run(async () => {
      await this.adapter.appendBinary(file.path, data, options);
      await this.afterWrite(file, null);
    });
  }

  /** Atomically reads, transforms and writes a file. Returns the written text. */
  process(file: TFile, fn: (data: string) => string, options?: DataWriteOptions): Promise<string> {
    return this.queue.run(async () => {
      const data = fn(await this.adapter.read(file.path));
      await this.adapter.write(file.path, data, options);
      await this.afterWrite(file, data);
      return data;
    });
  }

  /**
   * Deletes permanently. Without `force`, a folder is only removed if it has no hidden
   * children left once its visible children are gone.
   */
  delete(file: TAbstractFile, force?: boolean): Promise<void> {
    return this.queue.run(async () => {
      this.assertAttached(file);
      if (file instanceof TFolder) {
        if (force) await this.adapter.rmdir(file.path, true);
        else await this.deleteFolderContents(file);
      } else {
        await this.adapter.remove(file.path);
      }
      this.removeFromTree(file);
    });
  }

  /** Moves to the OS trash (`system`) with a fallback to the vault's `.trash` folder. */
  trash(file: TAbstractFile, system: boolean): Promise<void> {
    return this.queue.run(async () => {
      this.assertAttached(file);
      const done = system && (await this.adapter.trashSystem(file.path));
      if (!done) await this.adapter.trashLocal(file.path);
      this.removeFromTree(file);
    });
  }

  rename(file: TAbstractFile, newPath: string): Promise<void> {
    return this.queue.run(async () => {
      this.assertAttached(file);
      const to = normalizePath(newPath);
      if (to === file.path) return;
      if (file instanceof TFolder && (to + '/').startsWith(file.path + '/')) {
        throw new Error('Cannot move a folder into itself.');
      }
      const caseOnly = to.toLowerCase() === file.path.toLowerCase();
      if (!caseOnly && (this.fileMap[to] || (await this.adapter.exists(to)))) {
        throw new Error('Destination file already exists!');
      }
      await this.adapter.rename(file.path, to);
      this.moveInTree(file, to);
    });
  }

  copy<T extends TAbstractFile>(file: T, newPath: string): Promise<T> {
    return this.queue.run(async () => {
      this.assertAttached(file);
      const to = normalizePath(newPath);
      if (this.fileMap[to] || (await this.adapter.exists(to))) {
        throw new Error('Destination file already exists!');
      }
      await this.adapter.copy(file.path, to);
      if (file instanceof TFile) return (await this.addFileFromDisk(to)) as unknown as T;
      const folder = this.ensureFolderInTree(to);
      await this.scanFolder(folder);
      return folder as unknown as T;
    });
  }

  // ---------------------------------------------------------------------------------------
  // Tree maintenance

  private assertAttached(file: TAbstractFile): void {
    if (this.fileMap[file.path] !== file) throw new Error(`File not found: ${file.path}`);
    if (file === this.root) throw new Error('Cannot modify the vault root.');
  }

  private async prepareCreate(path: string): Promise<string> {
    const p = normalizePath(path);
    if (this.fileMap[p] || (await this.adapter.exists(p))) throw new Error('File already exists.');
    const parent = parentPath(p);
    if (!this.fileMap[parent]) {
      await this.adapter.mkdir(parent);
      this.ensureFolderInTree(parent);
    }
    return p;
  }

  private async afterWrite(file: TFile, data: string | null): Promise<void> {
    const stat = await this.adapter.stat(file.path);
    if (stat) file.stat = toFileStats(stat);
    if (data === null) this.contentCache.delete(file.path);
    else this.contentCache.set(file.path, { mtime: file.stat.mtime, data });
    this.trigger('modify', file);
  }

  private async deleteFolderContents(folder: TFolder): Promise<void> {
    for (const child of folder.children.slice()) {
      if (child instanceof TFolder) await this.deleteFolderContents(child);
      else await this.adapter.remove(child.path);
    }
    await this.adapter.rmdir(folder.path, false);
  }

  private async addFileFromDisk(path: string): Promise<TFile> {
    const stat = await this.adapter.stat(path);
    if (!stat || stat.type !== 'file') throw new Error(`File not found: ${path}`);
    return this.addFile(path, stat);
  }

  private addFile(path: string, stat: Stat): TFile {
    const parent = this.ensureFolderInTree(parentPath(path));
    const file = new TFile(this, path, toFileStats(stat));
    this.attach(file, parent);
    this.trigger('create', file);
    return file;
  }

  /** Returns the folder at `path`, adding it and any missing ancestors to the tree. */
  private ensureFolderInTree(path: string): TFolder {
    const existing = this.fileMap[path];
    if (existing instanceof TFolder) return existing;
    if (existing) throw new Error(`Expected a folder at ${path}`);
    const parent = this.ensureFolderInTree(parentPath(path));
    const folder = new TFolder(this, path);
    this.attach(folder, parent);
    this.trigger('create', folder);
    return folder;
  }

  private attach(file: TAbstractFile, parent: TFolder): void {
    file.parent = parent;
    parent.children.push(file);
    this.fileMap[file.path] = file;
  }

  private detach(file: TAbstractFile): void {
    const parent = file.parent;
    if (parent) {
      const idx = parent.children.indexOf(file);
      if (idx !== -1) parent.children.splice(idx, 1);
    }
    delete this.fileMap[file.path];
  }

  /** Removes an entry and its descendants, firing `delete` for each, deepest first. */
  private removeFromTree(file: TAbstractFile): void {
    if (file instanceof TFolder) {
      for (const child of file.children.slice()) this.removeFromTree(child);
    }
    this.detach(file);
    this.contentCache.delete(file.path);
    this.trigger('delete', file);
  }

  /** Moves an entry to a new path, firing `rename` for it and then each descendant. */
  private moveInTree(file: TAbstractFile, newPath: string): void {
    const renamed: Array<[TAbstractFile, string]> = [];
    const oldRoot = file.path;

    this.detach(file);
    const newParent = this.ensureFolderInTree(parentPath(newPath));
    const walk = (f: TAbstractFile) => {
      const oldPath = f.path;
      delete this.fileMap[oldPath];
      setFilePath(f, newPath + oldPath.slice(oldRoot.length));
      this.fileMap[f.path] = f;
      const cached = this.contentCache.get(oldPath);
      if (cached) {
        this.contentCache.delete(oldPath);
        this.contentCache.set(f.path, cached);
      }
      renamed.push([f, oldPath]);
      if (f instanceof TFolder) f.children.forEach(walk);
    };
    walk(file);
    this.attach(file, newParent);

    for (const [f, oldPath] of renamed) this.trigger('rename', f, oldPath);
  }

  /** Adds any entries found on disk under `folder` that are not in the tree yet. */
  private async scanFolder(folder: TFolder): Promise<void> {
    const listing = await this.adapter.list(folder.path);
    const files = listing.files.filter((p) => !isHiddenPath(p) && !this.fileMap[p]);
    const stats = await Promise.all(files.map((p) => this.adapter.stat(p)));
    files.forEach((p, i) => {
      const stat = stats[i];
      if (stat?.type === 'file') this.addFile(p, stat);
    });
    for (const p of listing.folders) {
      if (isHiddenPath(p)) continue;
      await this.scanFolder(this.ensureFolderInTree(p));
    }
  }

  // ---------------------------------------------------------------------------------------
  // External changes

  private onWatchEvent(path: string): void {
    this.trigger('raw', path);
    if (path === '/' || isHiddenPath(path)) return;
    this.pendingPaths.add(path);
    if (!this.pendingTimer) {
      this.pendingTimer = setTimeout(() => this.flushWatchEvents(), WATCH_DEBOUNCE_MS);
    }
  }

  private flushWatchEvents(): void {
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
    // Parents first, so a new folder is scanned before its reported children.
    const paths = [...this.pendingPaths].sort((a, b) => a.length - b.length);
    this.pendingPaths.clear();
    void this.queue
      .run(async () => {
        for (const p of paths) await this.reconcile(p);
      })
      .catch((err) => console.error('Failed to apply external change', err));
  }

  private async reconcile(path: string): Promise<void> {
    const stat = await this.adapter.stat(path);
    let existing: TAbstractFile | undefined = this.fileMap[path];

    if (existing && (!stat || (stat.type === 'folder') !== existing instanceof TFolder)) {
      this.removeFromTree(existing);
      existing = undefined;
    }
    if (!stat) return;

    if (stat.type === 'folder') {
      await this.scanFolder(this.ensureFolderInTree(path));
      return;
    }
    if (!existing) {
      this.addFile(path, stat);
      return;
    }
    const file = existing as TFile;
    if (file.stat.mtime !== stat.mtime || file.stat.size !== stat.size) {
      file.stat = toFileStats(stat);
      this.contentCache.delete(path);
      this.trigger('modify', file);
    }
  }
}

function toFileStats(stat: Stat): FileStats {
  return { ctime: stat.ctime, mtime: stat.mtime, size: stat.size };
}
