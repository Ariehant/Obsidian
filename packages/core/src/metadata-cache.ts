import { Events, type EventRef } from './events';
import { TFile, type TAbstractFile } from './files';
import type { LinkResolver } from './link-resolver';
import type { CachedMetadata, Reference, ReferenceCache } from './metadata-types';
import type { Vault } from './vault';

/** Parses a note into metadata. Injected so the app can run it in a worker. */
export interface MetadataParser {
  parse(text: string, path: string): CachedMetadata | Promise<CachedMetadata>;
}

export interface StoredMetadata {
  mtime: number;
  size: number;
  cache: CachedMetadata;
}

/** Persists parsed metadata between sessions so startup only re-parses changed notes. */
export interface MetadataStore {
  get(path: string): Promise<StoredMetadata | null>;
  set(path: string, entry: StoredMetadata): Promise<void>;
  delete(path: string): Promise<void>;
  keys(): Promise<string[]>;
}

/** Link path of a link (the part before `#`). */
export function linkpathOf(link: string): string {
  const idx = link.indexOf('#');
  return (idx === -1 ? link : link.slice(0, idx)).trim();
}

const INDEX_CONCURRENCY = 8;
const RESOLVE_DEBOUNCE_MS = 30;

/**
 * Metadata for every Markdown note, matching the plugin API's `MetadataCache`.
 *
 * Events: `changed` (file, data, cache) after a note is (re)parsed, `deleted` (file,
 * prevCache), `resolve` (file) after its links are resolved, and `resolved` once no work is
 * pending.
 */
export class MetadataCache extends Events {
  /** source path → destination path → link count. */
  resolvedLinks: Record<string, Record<string, number>> = {};
  /** source path → unresolved link path → count. */
  unresolvedLinks: Record<string, Record<string, number>> = {};

  private readonly entries = new Map<string, StoredMetadata>();
  private pending = 0;
  private resolveTimer: ReturnType<typeof setTimeout> | null = null;
  private initialized = false;
  /** Set once the initial indexing pass and resolution have finished. */
  private ready = false;
  private readonly refs: EventRef[] = [];
  /** Per-path generation, so a slow parse can't overwrite a newer one. */
  private readonly generation = new Map<string, number>();

  constructor(
    private readonly vault: Vault,
    private readonly resolver: LinkResolver,
    private readonly parser: MetadataParser,
    private readonly store: MetadataStore | null = null,
  ) {
    super();
  }

  override on(
    name: 'changed',
    callback: (file: TFile, data: string, cache: CachedMetadata) => any,
    ctx?: any,
  ): EventRef;
  override on(
    name: 'deleted',
    callback: (file: TFile, prevCache: CachedMetadata | null) => any,
    ctx?: any,
  ): EventRef;
  override on(name: 'resolve', callback: (file: TFile) => any, ctx?: any): EventRef;
  override on(name: 'resolved', callback: () => any, ctx?: any): EventRef;
  override on(name: string, callback: (...data: any[]) => any, ctx?: any): EventRef;
  override on(name: string, callback: (...data: any[]) => any, ctx?: any): EventRef {
    return super.on(name, callback, ctx);
  }

  /** Indexes the vault (reusing stored entries that are still current), then follows changes. */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    this.refs.push(
      this.vault.on('create', (f: TAbstractFile) => this.onCreateOrModify(f)),
      this.vault.on('modify', (f: TAbstractFile) => this.onCreateOrModify(f)),
      this.vault.on('delete', (f: TAbstractFile) => this.onDelete(f)),
      this.vault.on('rename', (f: TAbstractFile, oldPath: string) => this.onRename(f, oldPath)),
    );

    const files = this.vault.getMarkdownFiles();
    let next = 0;
    const worker = async () => {
      while (next < files.length) {
        const file = files[next++]!;
        try {
          await this.index(file, true);
        } catch (err) {
          console.error(`Failed to index ${file.path}`, err);
        }
      }
    };
    await Promise.all(Array.from({ length: INDEX_CONCURRENCY }, worker));

    if (this.store) {
      const live = new Set(files.map((f) => f.path));
      for (const key of await this.store.keys()) if (!live.has(key)) await this.store.delete(key);
    }
    this.resolveAll();
    this.ready = true;
    this.trigger('resolved');
  }

  dispose(): void {
    for (const ref of this.refs) this.vault.offref(ref);
    this.refs.length = 0;
    if (this.resolveTimer) clearTimeout(this.resolveTimer);
  }

  // ---------------------------------------------------------------------------------------
  // Queries (plugin API)

  getFileCache(file: TFile): CachedMetadata | null {
    return this.getCache(file.path);
  }

  getCache(path: string): CachedMetadata | null {
    return this.entries.get(path)?.cache ?? null;
  }

  getFirstLinkpathDest(linkpath: string, sourcePath: string): TFile | null {
    return this.resolver.getFirstLinkpathDest(linkpath, sourcePath);
  }

  /** Shortest link text that resolves to `file` from `sourcePath`. */
  fileToLinktext(file: TFile, sourcePath: string, omitMdExtension = true): string {
    const strip = (p: string) => (omitMdExtension && file.extension === 'md' ? p.replace(/\.md$/, '') : p);
    const name = strip(file.name);
    if (this.resolver.getFirstLinkpathDest(name, sourcePath) === file) return name;
    return strip(file.path);
  }

  // ---------------------------------------------------------------------------------------
  // Queries (internal API that plugins commonly use)

  /** Every reference to `file`, grouped by source path. */
  getBacklinksForFile(file: TFile): Map<string, ReferenceCache[]> {
    const out = new Map<string, ReferenceCache[]>();
    for (const [source, dests] of Object.entries(this.resolvedLinks)) {
      if (!dests[file.path]) continue;
      const refs = this.referencesTo(source, file);
      if (refs.length) out.set(source, refs);
    }
    return out;
  }

  /** References in `sourcePath` that resolve to `target`. */
  referencesTo(sourcePath: string, target: TFile): ReferenceCache[] {
    const cache = this.getCache(sourcePath);
    if (!cache) return [];
    return [...(cache.links ?? []), ...(cache.embeds ?? [])].filter((ref) => {
      const lp = linkpathOf(ref.link);
      return lp ? this.resolver.getFirstLinkpathDest(lp, sourcePath) === target : sourcePath === target.path;
    });
  }

  /** Tag → number of occurrences across the vault (frontmatter and body). */
  getTags(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const { cache } of this.entries.values()) {
      for (const tag of tagsOf(cache)) counts[tag] = (counts[tag] ?? 0) + 1;
    }
    return counts;
  }

  /** @internal Reads and parses a note now, bypassing the cache (for exact positions). */
  async parseFile(file: TFile): Promise<{ data: string; cache: CachedMetadata }> {
    const data = await this.vault.read(file);
    return { data, cache: await this.parser.parse(data, file.path) };
  }

  /** Whether indexing and link resolution are idle. */
  isResolved(): boolean {
    return this.ready && this.pending === 0 && !this.resolveTimer;
  }

  // ---------------------------------------------------------------------------------------
  // Indexing

  private async index(file: TFile, initial: boolean): Promise<void> {
    const gen = (this.generation.get(file.path) ?? 0) + 1;
    this.generation.set(file.path, gen);

    if (initial && this.store) {
      const stored = await this.store.get(file.path);
      if (stored && stored.mtime === file.stat.mtime && stored.size === file.stat.size) {
        this.entries.set(file.path, stored);
        return;
      }
    }
    const data = await this.vault.cachedRead(file);
    const cache = await this.parser.parse(data, file.path);
    if (this.generation.get(file.path) !== gen || this.vault.getFileByPath(file.path) !== file) return;
    const entry = { mtime: file.stat.mtime, size: file.stat.size, cache };
    this.entries.set(file.path, entry);
    void this.store?.set(file.path, entry).catch((err) => console.error('Metadata store write failed', err));
    this.trigger('changed', file, data, cache);
  }

  private onCreateOrModify(f: TAbstractFile): void {
    if (!(f instanceof TFile)) return;
    if (f.extension !== 'md') {
      this.scheduleResolveAll();
      return;
    }
    this.pending++;
    void this.index(f, false)
      .then(() => {
        if (this.entries.has(f.path)) this.resolveFile(f);
      })
      .catch((err) => console.error(`Failed to index ${f.path}`, err))
      .finally(() => {
        this.pending--;
        // A new file can resolve links elsewhere that were unresolved.
        this.scheduleResolveAll();
      });
  }

  private onDelete(f: TAbstractFile): void {
    if (!(f instanceof TFile)) return;
    const prev = this.entries.get(f.path)?.cache ?? null;
    if (f.extension === 'md') {
      this.entries.delete(f.path);
      this.generation.delete(f.path);
      delete this.resolvedLinks[f.path];
      delete this.unresolvedLinks[f.path];
      void this.store?.delete(f.path);
      this.trigger('deleted', f, prev);
    }
    this.scheduleResolveAll();
  }

  private onRename(f: TAbstractFile, oldPath: string): void {
    if (!(f instanceof TFile)) return;
    const entry = this.entries.get(oldPath);
    if (entry) {
      this.entries.delete(oldPath);
      this.entries.set(f.path, entry);
      void this.store?.delete(oldPath);
      void this.store?.set(f.path, entry);
    }
    // Keep the link maps consistent right away (a full re-resolve follows), so callers such
    // as FileManager see the new paths even when renames come in quick succession.
    for (const map of [this.resolvedLinks, this.unresolvedLinks]) {
      if (map[oldPath]) {
        map[f.path] = map[oldPath]!;
        delete map[oldPath];
      }
    }
    for (const dests of Object.values(this.resolvedLinks)) {
      const count = dests[oldPath];
      if (count === undefined) continue;
      dests[f.path] = (dests[f.path] ?? 0) + count;
      delete dests[oldPath];
    }
    if (f.extension === 'md' && !entry) this.onCreateOrModify(f);
    this.scheduleResolveAll();
  }

  // ---------------------------------------------------------------------------------------
  // Resolution

  private resolveFile(file: TFile): void {
    const cache = this.getCache(file.path);
    const resolved: Record<string, number> = {};
    const unresolved: Record<string, number> = {};
    const refs: Reference[] = [
      ...(cache?.links ?? []),
      ...(cache?.embeds ?? []),
      ...(cache?.frontmatterLinks ?? []),
    ];
    for (const ref of refs) {
      const lp = linkpathOf(ref.link);
      if (!lp) continue;
      const dest = this.resolver.getFirstLinkpathDest(lp, file.path);
      if (dest) resolved[dest.path] = (resolved[dest.path] ?? 0) + 1;
      else unresolved[lp] = (unresolved[lp] ?? 0) + 1;
    }
    this.resolvedLinks[file.path] = resolved;
    this.unresolvedLinks[file.path] = unresolved;
    this.trigger('resolve', file);
  }

  private resolveAll(): void {
    for (const path of this.entries.keys()) {
      const file = this.vault.getFileByPath(path);
      if (file) this.resolveFile(file);
    }
  }

  private scheduleResolveAll(): void {
    if (!this.initialized) return;
    if (this.resolveTimer) clearTimeout(this.resolveTimer);
    this.resolveTimer = setTimeout(() => {
      this.resolveTimer = null;
      if (this.pending > 0) return; // The last pending index reschedules.
      this.resolveAll();
      this.trigger('resolved');
    }, RESOLVE_DEBOUNCE_MS);
  }
}

function tagsOf(cache: CachedMetadata): string[] {
  const out: string[] = [];
  const fm = cache.frontmatter;
  if (fm) {
    for (const key of Object.keys(fm)) {
      if (key.toLowerCase() !== 'tags' && key.toLowerCase() !== 'tag') continue;
      const v = fm[key];
      const items = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,\s]+/) : [];
      for (const t of items) if (t) out.push(String(t).startsWith('#') ? String(t) : `#${t}`);
    }
  }
  for (const t of cache.tags ?? []) out.push(t.tag);
  return out;
}
