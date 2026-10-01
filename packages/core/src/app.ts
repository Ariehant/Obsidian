import { FileManager, type FileManagerOptions } from './file-manager';
import { Keymap, Scope } from './keymap';
import { LinkResolver } from './link-resolver';
import { MetadataCache, type MetadataParser, type MetadataStore } from './metadata-cache';
import type { Vault } from './vault';

export interface AppOptions {
  /** Note parser for the metadata cache (e.g. a worker client). */
  parser: MetadataParser;
  store?: MetadataStore | null;
  fileManager?: FileManagerOptions;
}

/**
 * Root object handed to plugins as `this.app` and exposed as the global `app`.
 *
 * Workspace, commands, settings and plugins are added as they are implemented; see
 * docs/PLAN.md §2.
 */
export class App {
  vault: Vault;
  metadataCache: MetadataCache;
  fileManager: FileManager;
  /** Root keyboard scope: app-wide shortcuts register here. */
  scope: Scope;
  keymap: Keymap;
  /** @internal Link resolution used by the metadata cache. */
  readonly linkResolver: LinkResolver;

  constructor(vault: Vault, options: AppOptions) {
    this.vault = vault;
    this.scope = new Scope();
    this.keymap = new Keymap(this.scope);
    this.linkResolver = new LinkResolver(vault);
    this.metadataCache = new MetadataCache(vault, this.linkResolver, options.parser, options.store ?? null);
    this.fileManager = new FileManager(vault, this.metadataCache, options.fileManager);
  }
}
