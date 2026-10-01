import type { MetadataStore, StoredMetadata } from '@basalt/core';

/** Bump when the shape of CachedMetadata or the parser's output changes. */
export const METADATA_FORMAT = 1;

const STORE = 'metadata';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Metadata cache persisted in IndexedDB, one database per vault. */
export class IndexedDbMetadataStore implements MetadataStore {
  private constructor(private readonly db: IDBDatabase) {}

  static async open(vaultPath: string): Promise<IndexedDbMetadataStore | null> {
    try {
      const name = `basalt-metadata-${await digest(vaultPath)}`;
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(name, METADATA_FORMAT);
        // A new format version starts from an empty store.
        req.onupgradeneeded = () => {
          if (req.result.objectStoreNames.contains(STORE)) req.result.deleteObjectStore(STORE);
          req.result.createObjectStore(STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      return new IndexedDbMetadataStore(db);
    } catch (err) {
      console.warn('Metadata store unavailable; indexing from scratch', err);
      return null;
    }
  }

  async get(path: string): Promise<StoredMetadata | null> {
    return ((await request(this.tx('readonly').get(path))) as StoredMetadata | undefined) ?? null;
  }

  async set(path: string, entry: StoredMetadata): Promise<void> {
    await request(this.tx('readwrite').put(entry, path));
  }

  async delete(path: string): Promise<void> {
    await request(this.tx('readwrite').delete(path));
  }

  async keys(): Promise<string[]> {
    return (await request(this.tx('readonly').getAllKeys())) as string[];
  }

  close(): void {
    this.db.close();
  }

  private tx(mode: IDBTransactionMode): IDBObjectStore {
    return this.db.transaction(STORE, mode).objectStore(STORE);
  }
}

async function digest(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes).slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** A store usable immediately; operations wait for the database to open (or no-op without one). */
export function lazyMetadataStore(vaultPath: string): MetadataStore & { close(): void } {
  const ready = IndexedDbMetadataStore.open(vaultPath);
  return {
    get: async (p) => (await ready)?.get(p) ?? null,
    set: async (p, e) => (await ready)?.set(p, e),
    delete: async (p) => (await ready)?.delete(p),
    keys: async () => (await ready)?.keys() ?? [],
    close: () => void ready.then((s) => s?.close()),
  };
}
