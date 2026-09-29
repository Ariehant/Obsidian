import { TFile, type TAbstractFile } from './files';
import { normalizePath, parentPath } from './path';
import type { Vault } from './vault';

/**
 * Resolves link paths (`[[Note]]`, `[[Folder/Note]]`, `![[image.png]]`) to files, with the
 * semantics of the plugin API's `MetadataCache.getFirstLinkpathDest`:
 *
 * 1. An empty link path refers to the source file itself (`[[#Heading]]`).
 * 2. A path containing `/` is tried relative to the source's folder, then from the vault
 *    root, then as a path suffix anywhere in the vault.
 * 3. Otherwise files whose name matches are candidates.
 * 4. Names are tried as written, then with `.md` appended. Exact case beats case-insensitive.
 * 5. Among candidates: same folder as the source first, then shortest path, then A→Z.
 *
 * Keeps a lower-cased name index up to date through vault events.
 */
export class LinkResolver {
  private readonly byName = new Map<string, TFile[]>();

  constructor(private readonly vault: Vault) {
    for (const f of vault.getFiles()) this.add(f);
    vault.on('create', (f: TAbstractFile) => f instanceof TFile && this.add(f));
    vault.on('delete', (f: TAbstractFile) => f instanceof TFile && this.remove(f, f.name));
    vault.on('rename', (f: TAbstractFile, oldPath: string) => {
      if (!(f instanceof TFile)) return;
      this.remove(f, oldPath.slice(oldPath.lastIndexOf('/') + 1));
      this.add(f);
    });
  }

  getFirstLinkpathDest(linkpath: string, sourcePath: string): TFile | null {
    let link = linkpath.trim();
    if (link === '') return this.vault.getFileByPath(sourcePath);
    link = link.replace(/^\.\//, '');

    const names = /\.[^/.]+$/.test(link) ? [link, `${link}.md`] : [`${link}.md`, link];
    if (link.includes('/')) {
      for (const name of names) {
        const relative = this.vault.getFileByPath(
          normalizePath(resolveRelative(parentPath(sourcePath), name)),
        );
        if (relative) return relative;
        const absolute = this.vault.getFileByPath(normalizePath(name));
        if (absolute) return absolute;
      }
    }

    const baseDir = parentPath(sourcePath);
    for (const name of names) {
      const base = name.slice(name.lastIndexOf('/') + 1);
      const suffix = name.includes('/') ? '/' + normalizePath(name).toLowerCase() : null;
      const candidates = (this.byName.get(base.toLowerCase()) ?? []).filter(
        (f) => !suffix || ('/' + f.path.toLowerCase()).endsWith(suffix),
      );
      if (!candidates.length) continue;
      const exact = candidates.filter((f) => f.name === base);
      return pickBest(exact.length ? exact : candidates, baseDir);
    }
    return null;
  }

  private add(file: TFile): void {
    const key = file.name.toLowerCase();
    const list = this.byName.get(key);
    if (list) list.push(file);
    else this.byName.set(key, [file]);
  }

  private remove(file: TFile, name: string): void {
    const key = name.toLowerCase();
    const list = this.byName.get(key)?.filter((f) => f !== file);
    if (list?.length) this.byName.set(key, list);
    else this.byName.delete(key);
  }
}

function pickBest(files: TFile[], baseDir: string): TFile {
  return files.slice().sort((a, b) => {
    const aSame = parentPath(a.path) === baseDir ? 0 : 1;
    const bSame = parentPath(b.path) === baseDir ? 0 : 1;
    return aSame - bSame || a.path.length - b.path.length || a.path.localeCompare(b.path);
  })[0]!;
}

/** Resolves `./` and `../` segments of `link` against `folder` (a vault path or `/`). */
function resolveRelative(folder: string, link: string): string {
  const parts = folder === '/' ? [] : folder.split('/');
  for (const seg of link.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.' && seg !== '') parts.push(seg);
  }
  return parts.join('/');
}
