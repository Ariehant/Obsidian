/** Storage backend for a vault. Paths are normalised vault paths (see `normalizePath`). */

export interface Stat {
  type: 'file' | 'folder';
  ctime: number;
  mtime: number;
  size: number;
}

export interface ListedFiles {
  files: string[];
  folders: string[];
}

export interface DataWriteOptions {
  ctime?: number;
  mtime?: number;
}

export interface DataAdapter {
  getName(): string;
  exists(normalizedPath: string, sensitive?: boolean): Promise<boolean>;
  stat(normalizedPath: string): Promise<Stat | null>;
  list(normalizedPath: string): Promise<ListedFiles>;
  read(normalizedPath: string): Promise<string>;
  readBinary(normalizedPath: string): Promise<ArrayBuffer>;
  write(normalizedPath: string, data: string, options?: DataWriteOptions): Promise<void>;
  writeBinary(normalizedPath: string, data: ArrayBuffer, options?: DataWriteOptions): Promise<void>;
  append(normalizedPath: string, data: string, options?: DataWriteOptions): Promise<void>;
  appendBinary(normalizedPath: string, data: ArrayBuffer, options?: DataWriteOptions): Promise<void>;
  process(normalizedPath: string, fn: (data: string) => string, options?: DataWriteOptions): Promise<string>;
  getResourcePath(normalizedPath: string): string;
  mkdir(normalizedPath: string): Promise<void>;
  trashSystem(normalizedPath: string): Promise<boolean>;
  trashLocal(normalizedPath: string): Promise<void>;
  rmdir(normalizedPath: string, recursive: boolean): Promise<void>;
  remove(normalizedPath: string): Promise<void>;
  rename(normalizedPath: string, normalizedNewPath: string): Promise<void>;
  copy(normalizedPath: string, normalizedNewPath: string): Promise<void>;
}

/**
 * Change notification from an adapter's watcher. Only the path is reported; the vault
 * re-stats it to find out what happened.
 */
export type WatchHandler = (normalizedPath: string) => void;

/** Adapters that can report external changes implement this (internal, not plugin API). */
export interface WatchableAdapter {
  watch(handler: WatchHandler): () => void;
}

export function isWatchable(adapter: DataAdapter): adapter is DataAdapter & WatchableAdapter {
  return typeof (adapter as Partial<WatchableAdapter>).watch === 'function';
}
