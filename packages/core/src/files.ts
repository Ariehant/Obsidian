import { basenameOf, splitExtension } from './path';
import type { Vault } from './vault';

export interface FileStats {
  ctime: number;
  mtime: number;
  size: number;
}

export abstract class TAbstractFile {
  vault: Vault;
  path: string;
  name: string;
  parent: TFolder | null = null;

  constructor(vault: Vault, path: string) {
    this.vault = vault;
    this.path = path;
    this.name = '';
    setFilePath(this, path);
  }
}

/**
 * @internal Updates a file's path and the fields derived from it. A free function rather
 * than a method so the classes' public shape stays identical to the plugin API.
 */
export function setFilePath(file: TAbstractFile, path: string): void {
  file.path = path;
  file.name = path === '/' ? '' : basenameOf(path);
  if (file instanceof TFile) {
    const { basename, extension } = splitExtension(file.name);
    file.basename = basename;
    file.extension = extension;
  }
}

export class TFile extends TAbstractFile {
  stat: FileStats;
  basename: string;
  extension: string;

  constructor(vault: Vault, path: string, stat: FileStats) {
    super(vault, path);
    this.stat = stat;
    const { basename, extension } = splitExtension(this.name);
    this.basename = basename;
    this.extension = extension;
  }
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];

  isRoot(): boolean {
    return this.path === '/';
  }
}
