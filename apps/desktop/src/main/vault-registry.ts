import * as fs from 'node:fs';
import * as path from 'node:path';

export interface VaultEntry {
  path: string;
  /** Last time the vault was opened (ms since epoch). */
  ts: number;
}

interface RegistryFile {
  vaults: Record<string, VaultEntry>;
  current: string | null;
}

/**
 * Known vaults, persisted as `vaults.json` in the app's user-data folder. Ids are stable
 * random strings so a vault keeps its identity if the file is edited by hand.
 */
export class VaultRegistry {
  private readonly file: string;
  private data: RegistryFile;

  constructor(userDataDir: string) {
    this.file = path.join(userDataDir, 'vaults.json');
    this.data = this.readFile();
  }

  /** Vaults whose folder still exists, most recently opened first. */
  recent(): VaultEntry[] {
    return Object.values(this.data.vaults)
      .filter((v) => isDirectory(v.path))
      .sort((a, b) => b.ts - a.ts);
  }

  current(): string | null {
    const id = this.data.current;
    const entry = id ? this.data.vaults[id] : undefined;
    return entry && isDirectory(entry.path) ? entry.path : null;
  }

  /** Marks a vault as the current one and records it as opened now. */
  open(vaultPath: string): void {
    const resolved = path.resolve(vaultPath);
    let id = Object.keys(this.data.vaults).find((k) => this.data.vaults[k]!.path === resolved);
    if (!id) id = Math.random().toString(16).slice(2, 18);
    this.data.vaults[id] = { path: resolved, ts: Date.now() };
    this.data.current = id;
    this.save();
  }

  closeCurrent(): void {
    this.data.current = null;
    this.save();
  }

  private readFile(): RegistryFile {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<RegistryFile>;
      return { vaults: parsed.vaults ?? {}, current: parsed.current ?? null };
    } catch {
      return { vaults: {}, current: null };
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
}

export function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
