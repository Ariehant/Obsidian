import type { DataWriteOptions } from './adapter';
import { getFrontMatterInfo, parseYaml, stringifyYaml } from './frontmatter';
import { TFile, TFolder, type TAbstractFile } from './files';
import { linkpathOf, type MetadataCache } from './metadata-cache';
import type { Reference, ReferenceCache } from './metadata-types';
import { joinPath, normalizePath, parentPath, splitExtension } from './path';
import { Vault } from './vault';

export interface FileManagerOptions {
  /** Asks the user before deleting. Defaults to always confirming. */
  confirmDeletion?: (file: TAbstractFile) => Promise<boolean>;
}

interface PendingEdit {
  ref: Reference & Partial<ReferenceCache>;
  target: TFile;
  inFrontmatter: boolean;
}

/** Path of `to` relative to the folder `fromDir` (a vault path or `/`). */
function relativePath(fromDir: string, to: string): string {
  const from = fromDir === '/' ? [] : fromDir.split('/');
  const parts = to.split('/');
  let i = 0;
  while (i < from.length && i < parts.length - 1 && from[i] === parts[i]) i++;
  return [...from.slice(i).map(() => '..'), ...parts.slice(i)].join('/');
}

const encodeLinkPath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

/**
 * File operations that keep the vault consistent, matching the plugin API's `FileManager`:
 * renames rewrite links pointing at the moved files, deletions respect the trash setting.
 *
 * Settings come from `vault.getConfig` (the same keys as `.obsidian/app.json`):
 * `newFileLocation`, `newFileFolderPath`, `attachmentFolderPath`, `useMarkdownLinks`,
 * `newLinkFormat`, `alwaysUpdateLinks`, `trashOption`.
 */
export class FileManager {
  constructor(
    private readonly vault: Vault,
    private readonly metadataCache: MetadataCache,
    private readonly options: FileManagerOptions = {},
  ) {}

  getNewFileParent(sourcePath: string, _newFilePath?: string): TFolder {
    const location = this.vault.getConfig('newFileLocation') ?? 'root';
    if (location === 'current') {
      const folder = this.vault.getFileByPath(sourcePath)?.parent;
      if (folder) return folder;
    } else if (location === 'folder') {
      const folder = this.vault.getFolderByPath(String(this.vault.getConfig('newFileFolderPath') ?? '/'));
      if (folder) return folder;
    }
    return this.vault.getRoot();
  }

  /** Renames or moves `file`, then rewrites links to it (and to files inside it). */
  async renameFile(file: TAbstractFile, newPath: string): Promise<void> {
    const moved = new Set<TFile>();
    if (file instanceof TFile) moved.add(file);
    else if (file instanceof TFolder) Vault.recurseChildren(file, (f) => f instanceof TFile && moved.add(f));

    // Find every reference to a moved file before renaming, from a fresh parse of each
    // source so positions match the text on disk.
    const edits = new Map<TFile, { list: PendingEdit[] }>();
    if (this.vault.getConfig('alwaysUpdateLinks') !== false) {
      const movedPaths = new Set([...moved].map((f) => f.path));
      for (const [source, dests] of Object.entries(this.metadataCache.resolvedLinks)) {
        if (!Object.keys(dests).some((d) => movedPaths.has(d))) continue;
        const sourceFile = this.vault.getFileByPath(source);
        if (!sourceFile) continue;
        const { cache } = await this.metadataCache.parseFile(sourceFile);
        const list: PendingEdit[] = [];
        const consider = (ref: Reference, inFrontmatter: boolean) => {
          const lp = linkpathOf(ref.link);
          if (!lp) return;
          const target = this.metadataCache.getFirstLinkpathDest(lp, source);
          if (target && moved.has(target)) list.push({ ref, target, inFrontmatter });
        };
        for (const ref of [...(cache.links ?? []), ...(cache.embeds ?? [])]) consider(ref, false);
        for (const ref of cache.frontmatterLinks ?? []) consider(ref, true);
        if (list.length) edits.set(sourceFile, { list });
      }
    }

    await this.vault.rename(file, normalizePath(newPath));

    for (const [source, { list }] of edits) {
      // If the note changed between parsing and now, positions may be off; applyEdits
      // verifies each one against the text and falls back to matching the original.
      await this.vault.process(source, (text) => this.applyEdits(text, list, source.path));
    }
  }

  async promptForDeletion(file: TAbstractFile): Promise<boolean> {
    const ok = this.options.confirmDeletion ? await this.options.confirmDeletion(file) : true;
    if (ok) await this.trashFile(file);
    return ok;
  }

  async trashFile(file: TAbstractFile): Promise<void> {
    const option = this.vault.getConfig('trashOption') ?? 'system';
    if (option === 'none') await this.vault.delete(file, true);
    else await this.vault.trash(file, option === 'system');
  }

  /** A link to `file` from `sourcePath`, in the configured style (wikilink by default). */
  generateMarkdownLink(file: TFile, sourcePath: string, subpath = '', alias = ''): string {
    if (this.vault.getConfig('useMarkdownLinks')) {
      const path = this.linkPath(file, sourcePath, false);
      const text = alias || (file.extension === 'md' ? file.basename : file.name);
      return `[${text}](${encodeLinkPath(path)}${subpath})`;
    }
    const linktext = this.linkPath(file, sourcePath, true);
    return `[[${linktext}${subpath}${alias ? `|${alias}` : ''}]]`;
  }

  /** Edits a note's YAML frontmatter in place, creating the block if needed. */
  async processFrontMatter(
    file: TFile,
    fn: (frontmatter: any) => void,
    options?: DataWriteOptions,
  ): Promise<void> {
    await this.vault.process(
      file,
      (text) => {
        const info = getFrontMatterInfo(text);
        const data = (info.exists ? parseYaml(info.frontmatter) : null) ?? {};
        if (typeof data !== 'object' || Array.isArray(data))
          throw new Error('Frontmatter is not a YAML mapping.');
        fn(data);
        if (!info.exists && !Object.keys(data).length) return text;
        const yaml = Object.keys(data).length ? stringifyYaml(data) : '';
        const block = `---\n${yaml}---\n`;
        return info.exists ? block + text.slice(info.contentStart) : block + text;
      },
      options,
    );
  }

  /** A free path for a new attachment, following `attachmentFolderPath`. Creates the folder. */
  async getAvailablePathForAttachment(filename: string, sourcePath?: string): Promise<string> {
    const setting = String(this.vault.getConfig('attachmentFolderPath') ?? '/');
    let folder: string;
    if (setting === './' || setting.startsWith('./')) {
      const base = sourcePath ? parentPath(sourcePath) : '/';
      folder = normalizePath(joinPath(base, setting.slice(2)));
    } else {
      folder = normalizePath(setting);
    }
    if (folder !== '/' && !this.vault.getFolderByPath(folder)) await this.vault.createFolder(folder);
    const { basename, extension } = splitExtension(filename);
    const ext = extension ? `.${extension}` : '';
    for (let i = 0; ; i++) {
      const candidate = joinPath(folder, `${basename}${i ? ` ${i}` : ''}${ext}`);
      if (!this.vault.getAbstractFileByPath(candidate) && !(await this.vault.adapter.exists(candidate)))
        return candidate;
    }
  }

  // ---------------------------------------------------------------------------------------

  /** Link path to `file` per `newLinkFormat` (`shortest` default, `relative`, `absolute`). */
  private linkPath(file: TFile, sourcePath: string, omitMd: boolean): string {
    const format = this.vault.getConfig('newLinkFormat') ?? 'shortest';
    const strip = (p: string) => (omitMd && file.extension === 'md' ? p.replace(/\.md$/, '') : p);
    if (format === 'absolute') return strip(file.path);
    if (format === 'relative') return strip(relativePath(parentPath(sourcePath), file.path));
    return this.metadataCache.fileToLinktext(file, sourcePath, omitMd);
  }

  private newReferenceText(ref: Reference, target: TFile, sourcePath: string): string {
    const original = ref.original;
    const hash = ref.link.indexOf('#');
    const subpath = hash === -1 ? '' : ref.link.slice(hash);

    const wiki = /^(!?)\[\[([\s\S]*)\]\]$/.exec(original);
    if (wiki) {
      const inner = wiki[2]!;
      const pipe = inner.indexOf('|');
      const aliasPart = pipe === -1 ? '' : inner.slice(inner[pipe - 1] === '\\' ? pipe - 1 : pipe);
      const oldPath = linkpathOf(
        pipe === -1 ? inner : inner.slice(0, inner[pipe - 1] === '\\' ? pipe - 1 : pipe),
      );
      const keepMd = /\.md$/i.test(oldPath);
      // A link written as a path stays a path; a bare name gets the shortest form.
      let linktext = oldPath.includes('/')
        ? target.path
        : this.metadataCache.fileToLinktext(target, sourcePath, true);
      if (!keepMd) linktext = linktext.replace(/\.md$/, '');
      else if (target.extension === 'md' && !linktext.endsWith('.md')) linktext += '.md';
      return `${wiki[1]}[[${linktext}${subpath}${aliasPart}]]`;
    }

    const md = /^(!?\[[\s\S]*?\]\()(<[^>]*>|[^\s)]+)([\s\S]*\))$/.exec(original);
    if (md) {
      const oldUrl = md[2]!.replace(/^<|>$/g, '');
      // Keep relative links relative; anything else becomes a vault path, which always resolves.
      const relative = oldUrl.startsWith('./') || oldUrl.startsWith('../');
      const path = relative ? relativePath(parentPath(sourcePath), target.path) : target.path;
      return `${md[1]}${encodeLinkPath(path)}${subpath}${md[3]}`;
    }
    return original;
  }

  private applyEdits(text: string, edits: PendingEdit[], sourcePath: string): string {
    const positioned = edits
      .filter((e) => !e.inFrontmatter && e.ref.position)
      .sort((a, b) => b.ref.position!.start.offset - a.ref.position!.start.offset);
    for (const { ref, target } of positioned) {
      const { start, end } = ref.position!;
      const replacement = this.newReferenceText(ref, target, sourcePath);
      if (text.slice(start.offset, end.offset) === ref.original) {
        text = text.slice(0, start.offset) + replacement + text.slice(end.offset);
      } else {
        // The note changed since it was indexed; fall back to the first exact occurrence.
        const idx = text.indexOf(ref.original);
        if (idx !== -1) text = text.slice(0, idx) + replacement + text.slice(idx + ref.original.length);
      }
    }
    const fmEdits = edits.filter((e) => e.inFrontmatter);
    if (fmEdits.length) {
      const info = getFrontMatterInfo(text);
      if (info.exists) {
        let yaml = text.slice(info.from, info.to);
        for (const { ref, target } of fmEdits) {
          yaml = yaml.split(ref.original).join(this.newReferenceText(ref, target, sourcePath));
        }
        text = text.slice(0, info.from) + yaml + text.slice(info.to);
      }
    }
    return text;
  }
}
