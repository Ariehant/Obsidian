import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as nodePath from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  DataAdapter,
  DataWriteOptions,
  ListedFiles,
  Stat,
  WatchableAdapter,
  WatchHandler,
} from './adapter';
import { basenameOf, joinPath, normalizePath, parentPath, splitExtension } from './path';

export interface FileSystemAdapterOptions {
  /** Moves a file to the OS trash. Supplied by the host (e.g. Electron's `shell.trashItem`). */
  trashItem?: (fullPath: string) => Promise<void>;
  /** URL prefix under which the host serves vault files. Defaults to `app://local`. */
  resourceUrlBase?: string;
}

/** Folder, relative to the vault root, used by `trashLocal`. */
export const LOCAL_TRASH_FOLDER = '.trash';

export class FileSystemAdapter implements DataAdapter, WatchableAdapter {
  private readonly basePath: string;
  private readonly options: FileSystemAdapterOptions;

  constructor(basePath: string, options: FileSystemAdapterOptions = {}) {
    this.basePath = nodePath.resolve(basePath);
    this.options = options;
  }

  getName(): string {
    return nodePath.basename(this.basePath);
  }

  getBasePath(): string {
    return this.basePath;
  }

  /** Absolute path of a vault path. Throws for paths that would leave the vault (`..`). */
  getFullPath(normalizedPath: string): string {
    const p = normalizePath(normalizedPath);
    if (p === '/') return this.basePath;
    const full = nodePath.join(this.basePath, ...p.split('/'));
    const rel = nodePath.relative(this.basePath, full);
    if (rel.startsWith('..') || nodePath.isAbsolute(rel)) {
      throw new Error(`Path is outside the vault: ${normalizedPath}`);
    }
    return full;
  }

  getFilePath(normalizedPath: string): string {
    return pathToFileURL(this.getFullPath(normalizedPath)).href;
  }

  getResourcePath(normalizedPath: string): string {
    const base = this.options.resourceUrlBase ?? 'app://local';
    const full = this.getFullPath(normalizedPath).split(nodePath.sep).join('/');
    const encoded = full
      .split('/')
      .map((seg) => encodeURIComponent(seg))
      .join('/');
    return `${base}${encoded.startsWith('/') ? '' : '/'}${encoded}`;
  }

  async exists(normalizedPath: string, sensitive?: boolean): Promise<boolean> {
    const full = this.getFullPath(normalizedPath);
    try {
      await fsp.access(full);
    } catch {
      return false;
    }
    if (!sensitive || normalizePath(normalizedPath) === '/') return true;
    // On case-insensitive file systems `access` matches regardless of case.
    const names = await fsp.readdir(nodePath.dirname(full));
    return names.includes(nodePath.basename(full));
  }

  async stat(normalizedPath: string): Promise<Stat | null> {
    try {
      const s = await fsp.stat(this.getFullPath(normalizedPath));
      return toStat(s);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async list(normalizedPath: string): Promise<ListedFiles> {
    const folder = normalizePath(normalizedPath);
    const full = this.getFullPath(folder);
    const entries = await fsp.readdir(full, { withFileTypes: true });
    const result: ListedFiles = { files: [], folders: [] };
    for (const entry of entries) {
      const child = joinPath(folder, entry.name.normalize('NFC'));
      let isDir = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          isDir = (await fsp.stat(nodePath.join(full, entry.name))).isDirectory();
        } catch {
          continue; // dangling link
        }
      } else if (!isDir && !entry.isFile()) {
        continue; // sockets, fifos, devices
      }
      (isDir ? result.folders : result.files).push(child);
    }
    return result;
  }

  async read(normalizedPath: string): Promise<string> {
    return fsp.readFile(this.getFullPath(normalizedPath), 'utf8');
  }

  async readBinary(normalizedPath: string): Promise<ArrayBuffer> {
    const buf = await fsp.readFile(this.getFullPath(normalizedPath));
    return toArrayBuffer(buf);
  }

  async write(normalizedPath: string, data: string, options?: DataWriteOptions): Promise<void> {
    const full = await this.prepareWrite(normalizedPath);
    await fsp.writeFile(full, data, 'utf8');
    await applyTimes(full, options);
  }

  async writeBinary(normalizedPath: string, data: ArrayBuffer, options?: DataWriteOptions): Promise<void> {
    const full = await this.prepareWrite(normalizedPath);
    await fsp.writeFile(full, new Uint8Array(data));
    await applyTimes(full, options);
  }

  async append(normalizedPath: string, data: string, options?: DataWriteOptions): Promise<void> {
    const full = await this.prepareWrite(normalizedPath);
    await fsp.appendFile(full, data, 'utf8');
    await applyTimes(full, options);
  }

  async appendBinary(normalizedPath: string, data: ArrayBuffer, options?: DataWriteOptions): Promise<void> {
    const full = await this.prepareWrite(normalizedPath);
    await fsp.appendFile(full, new Uint8Array(data));
    await applyTimes(full, options);
  }

  async process(
    normalizedPath: string,
    fn: (data: string) => string,
    options?: DataWriteOptions,
  ): Promise<string> {
    const data = fn(await this.read(normalizedPath));
    await this.write(normalizedPath, data, options);
    return data;
  }

  async mkdir(normalizedPath: string): Promise<void> {
    await fsp.mkdir(this.getFullPath(normalizedPath), { recursive: true });
  }

  async trashSystem(normalizedPath: string): Promise<boolean> {
    if (!this.options.trashItem) return false;
    try {
      await this.options.trashItem(this.getFullPath(normalizedPath));
      return true;
    } catch (err) {
      console.error('System trash failed', err);
      return false;
    }
  }

  async trashLocal(normalizedPath: string): Promise<void> {
    const source = normalizePath(normalizedPath);
    await this.mkdir(LOCAL_TRASH_FOLDER);
    const { basename, extension } = splitExtension(basenameOf(source));
    const suffix = extension ? `.${extension}` : '';
    let target = joinPath(LOCAL_TRASH_FOLDER, basenameOf(source));
    for (let i = 1; await this.exists(target); i++) {
      target = joinPath(LOCAL_TRASH_FOLDER, `${basename} ${i}${suffix}`);
    }
    await fsp.rename(this.getFullPath(source), this.getFullPath(target));
  }

  async rmdir(normalizedPath: string, recursive: boolean): Promise<void> {
    const full = this.getFullPath(normalizedPath);
    if (recursive) await fsp.rm(full, { recursive: true });
    else await fsp.rmdir(full);
  }

  async remove(normalizedPath: string): Promise<void> {
    await fsp.unlink(this.getFullPath(normalizedPath));
  }

  async rename(normalizedPath: string, normalizedNewPath: string): Promise<void> {
    const from = normalizePath(normalizedPath);
    const to = normalizePath(normalizedNewPath);
    const caseOnly = from !== to && from.toLowerCase() === to.toLowerCase();
    if (!caseOnly && (await this.exists(to))) throw new Error('Destination file already exists!');
    await this.mkdir(parentPath(to));
    await fsp.rename(this.getFullPath(from), this.getFullPath(to));
  }

  async copy(normalizedPath: string, normalizedNewPath: string): Promise<void> {
    const to = normalizePath(normalizedNewPath);
    if (await this.exists(to)) throw new Error('Destination file already exists!');
    await this.mkdir(parentPath(to));
    await fsp.cp(this.getFullPath(normalizedPath), this.getFullPath(to), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
  }

  watch(handler: WatchHandler): () => void {
    const watcher = fs.watch(this.basePath, { recursive: true }, (_event, filename) => {
      if (filename == null) return;
      handler(normalizePath(filename.toString().split(nodePath.sep).join('/')));
    });
    watcher.on('error', (err) => console.error('Vault watcher error', err));
    return () => watcher.close();
  }

  static async readLocalFile(path: string): Promise<ArrayBuffer> {
    return toArrayBuffer(await fsp.readFile(path));
  }

  static async mkdir(path: string): Promise<void> {
    await fsp.mkdir(path, { recursive: true });
  }

  private async prepareWrite(normalizedPath: string): Promise<string> {
    const p = normalizePath(normalizedPath);
    await this.mkdir(parentPath(p));
    return this.getFullPath(p);
  }
}

function toStat(s: fs.Stats): Stat {
  return {
    type: s.isDirectory() ? 'folder' : 'file',
    // birthtime is 0 on file systems that do not record it.
    ctime: Math.round(s.birthtimeMs || s.ctimeMs),
    mtime: Math.round(s.mtimeMs),
    size: s.size,
  };
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

async function applyTimes(full: string, options?: DataWriteOptions): Promise<void> {
  if (options?.mtime == null) return;
  const mtime = new Date(options.mtime);
  await fsp.utimes(full, mtime, mtime);
}

function isNotFound(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
