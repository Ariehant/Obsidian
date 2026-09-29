import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileSystemAdapter, TFile, TFolder, Vault, type TAbstractFile } from '../src';

let dir: string;
let vault: Vault;
let events: string[];

async function write(rel: string, data: string) {
  const full = path.join(dir, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, data);
}

function record(v: Vault) {
  const log: string[] = [];
  v.on('create', (f: TAbstractFile) => log.push(`create ${f.path}`));
  v.on('modify', (f: TAbstractFile) => log.push(`modify ${f.path}`));
  v.on('delete', (f: TAbstractFile) => log.push(`delete ${f.path}`));
  v.on('rename', (f: TAbstractFile, old: string) => log.push(`rename ${old} -> ${f.path}`));
  return log;
}

async function openVault(): Promise<Vault> {
  const v = new Vault(new FileSystemAdapter(dir));
  events = record(v);
  await v.load();
  return v;
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'basalt-vault-'));
});

afterEach(async () => {
  vault?.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('Vault loading', () => {
  it('builds the tree and skips hidden entries', async () => {
    await write('Welcome.md', '# Hi');
    await write('Projects/Robot/arm.md', 'x');
    await write('Projects/image.png', 'png');
    await write('.obsidian/app.json', '{}');
    await write('Projects/.hidden.md', 'x');
    vault = await openVault();

    expect(
      vault
        .getAllLoadedFiles()
        .map((f) => f.path)
        .sort(),
    ).toEqual([
      '/',
      'Projects',
      'Projects/Robot',
      'Projects/Robot/arm.md',
      'Projects/image.png',
      'Welcome.md',
    ]);
    expect(vault.getMarkdownFiles().map((f) => f.path)).toHaveLength(2);

    const arm = vault.getFileByPath('Projects/Robot/arm.md')!;
    expect(arm).toBeInstanceOf(TFile);
    expect([arm.name, arm.basename, arm.extension]).toEqual(['arm.md', 'arm', 'md']);
    expect(arm.parent?.path).toBe('Projects/Robot');
    expect(arm.parent?.parent?.parent).toBe(vault.getRoot());
    expect(vault.getRoot().isRoot()).toBe(true);
    expect(vault.getFolderByPath('/Projects/')).toBeInstanceOf(TFolder);
    expect(events).toContain('create Projects/Robot/arm.md');
  });
});

describe('Vault mutations', () => {
  beforeEach(async () => {
    await write('a.md', 'alpha');
    vault = await openVault();
    events.length = 0;
  });

  it('creates files and missing parent folders', async () => {
    const f = await vault.create('New/Deep/note.md', 'hello');
    expect(await fs.readFile(path.join(dir, 'New/Deep/note.md'), 'utf8')).toBe('hello');
    expect(f.parent?.path).toBe('New/Deep');
    expect(events).toEqual(['create New', 'create New/Deep', 'create New/Deep/note.md']);
    await expect(vault.create('a.md', '')).rejects.toThrow('File already exists.');
  });

  it('creates folders and rejects duplicates', async () => {
    const folder = await vault.createFolder('X/Y');
    expect(folder.path).toBe('X/Y');
    await expect(vault.createFolder('X/Y')).rejects.toThrow('Folder already exists.');
  });

  it('reads, modifies, appends and processes', async () => {
    const f = vault.getFileByPath('a.md')!;
    expect(await vault.read(f)).toBe('alpha');
    await vault.modify(f, 'beta');
    expect(await vault.cachedRead(f)).toBe('beta');
    await vault.append(f, '!');
    expect(await vault.read(f)).toBe('beta!');
    expect(await vault.process(f, (s) => s.toUpperCase())).toBe('BETA!');
    expect(await fs.readFile(path.join(dir, 'a.md'), 'utf8')).toBe('BETA!');
    expect(f.stat.size).toBe(5);
    expect(events).toEqual(['modify a.md', 'modify a.md', 'modify a.md']);
  });

  it('renames folders and fires rename for each descendant', async () => {
    await vault.create('F/one.md', '1');
    await vault.create('F/Sub/two.md', '2');
    events.length = 0;
    await vault.rename(vault.getFolderByPath('F')!, 'G/F2');

    expect(vault.getFileByPath('G/F2/Sub/two.md')?.basename).toBe('two');
    expect(vault.getAbstractFileByPath('F')).toBeNull();
    expect(events).toEqual([
      'create G',
      'rename F -> G/F2',
      'rename F/one.md -> G/F2/one.md',
      'rename F/Sub -> G/F2/Sub',
      'rename F/Sub/two.md -> G/F2/Sub/two.md',
    ]);
    await expect(vault.rename(vault.getFileByPath('a.md')!, 'G/F2/one.md')).rejects.toThrow('already exists');
  });

  it('deletes folders recursively, deepest first', async () => {
    await vault.create('F/Sub/two.md', '2');
    events.length = 0;
    await vault.delete(vault.getFolderByPath('F')!);
    expect(events).toEqual(['delete F/Sub/two.md', 'delete F/Sub', 'delete F']);
    await expect(fs.stat(path.join(dir, 'F'))).rejects.toThrow();
  });

  it('refuses to delete a folder with hidden children unless forced', async () => {
    await vault.createFolder('F');
    await write('F/.keep', '');
    const folder = vault.getFolderByPath('F')!;
    await expect(vault.delete(folder)).rejects.toThrow();
    await vault.delete(folder, true);
    expect(vault.getFolderByPath('F')).toBeNull();
  });

  it('trashes to the local .trash folder when system trash is unavailable', async () => {
    await vault.trash(vault.getFileByPath('a.md')!, true);
    expect(await fs.readFile(path.join(dir, '.trash/a.md'), 'utf8')).toBe('alpha');
    expect(vault.getFileByPath('a.md')).toBeNull();
    expect(events).toEqual(['delete a.md']);
  });

  it('refuses paths that leave the vault', async () => {
    await expect(vault.create('../outside.md', 'x')).rejects.toThrow('outside the vault');
    await expect(vault.create('a/../../outside.md', 'x')).rejects.toThrow('outside the vault');
    await expect(fs.stat(path.join(dir, '..', 'outside.md'))).rejects.toThrow();
  });

  it('copies files', async () => {
    const copy = await vault.copy(vault.getFileByPath('a.md')!, 'b.md');
    expect(copy.path).toBe('b.md');
    expect(await vault.read(copy)).toBe('alpha');
  });
});

describe('Vault external changes', () => {
  beforeEach(async () => {
    await write('a.md', 'alpha');
    vault = await openVault();
    events.length = 0;
  });

  const settle = () => vi.waitFor(() => vault.whenIdle(), { timeout: 2000 });

  it('picks up created, modified and deleted files', async () => {
    await write('Ext/new.md', 'n');
    await vi.waitFor(async () => {
      await vault.whenIdle();
      expect(vault.getFileByPath('Ext/new.md')).not.toBeNull();
    });

    await write('a.md', 'changed externally');
    await vi.waitFor(async () => {
      await vault.whenIdle();
      expect(events).toContain('modify a.md');
    });
    expect(await vault.cachedRead(vault.getFileByPath('a.md')!)).toBe('changed externally');

    await fs.rm(path.join(dir, 'Ext'), { recursive: true });
    await vi.waitFor(async () => {
      await vault.whenIdle();
      expect(vault.getFolderByPath('Ext')).toBeNull();
    });
    expect(events).toContain('delete Ext/new.md');
  });

  it('does not echo its own writes as external modifications', async () => {
    const f = vault.getFileByPath('a.md')!;
    await vault.modify(f, 'mine');
    await new Promise((r) => setTimeout(r, 200));
    await settle();
    expect(events).toEqual(['modify a.md']);
  });

  it('reports hidden-path changes only as raw events', async () => {
    const raw: string[] = [];
    vault.on('raw', (p: string) => raw.push(p));
    await write('.obsidian/app.json', '{}');
    await vi.waitFor(() => expect(raw).toContain('.obsidian/app.json'));
    await settle();
    expect(vault.getAbstractFileByPath('.obsidian')).toBeNull();
  });
});
