import { describe, expect, it } from 'vitest';
import type { DataAdapter, ListedFiles, Stat } from '../src';
import { LinkResolver, Vault } from '../src';

/** In-memory adapter: enough for loading a vault and renaming files. */
function memoryAdapter(paths: string[]): DataAdapter {
  const files = new Set(paths);
  const folders = new Set<string>();
  for (const p of paths) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'));
  }
  const stat = (p: string): Stat | null =>
    files.has(p)
      ? { type: 'file', ctime: 0, mtime: 0, size: 0 }
      : folders.has(p)
        ? { type: 'folder', ctime: 0, mtime: 0, size: 0 }
        : null;
  const list = (dir: string): ListedFiles => {
    const prefix = dir === '/' ? '' : dir + '/';
    const direct = (p: string) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/');
    return { files: [...files].filter(direct), folders: [...folders].filter(direct) };
  };
  const unsupported = async () => {
    throw new Error('not supported');
  };
  return {
    getName: () => 'mem',
    exists: async (p) => stat(p) !== null,
    stat: async (p) => stat(p),
    list: async (p) => list(p),
    rename: async (from, to) => {
      files.delete(from);
      files.add(to);
    },
    read: async () => '',
    readBinary: unsupported,
    write: unsupported,
    writeBinary: unsupported,
    append: unsupported,
    appendBinary: unsupported,
    process: unsupported,
    getResourcePath: (p) => p,
    mkdir: async (p) => void folders.add(p),
    trashSystem: async () => false,
    trashLocal: unsupported,
    rmdir: unsupported,
    remove: unsupported,
    copy: unsupported,
  };
}

async function setup(paths: string[]) {
  const vault = new Vault(memoryAdapter(paths));
  await vault.load();
  const resolver = new LinkResolver(vault);
  const resolve = (link: string, source = 'Index.md') =>
    resolver.getFirstLinkpathDest(link, source)?.path ?? null;
  return { vault, resolve };
}

describe('LinkResolver', () => {
  it('resolves by name with and without extension', async () => {
    const { resolve } = await setup(['Index.md', 'Notes/Robot arm.md', 'img/diagram.png', 'Data.v2.md']);
    expect(resolve('Robot arm')).toBe('Notes/Robot arm.md');
    expect(resolve('robot ARM')).toBe('Notes/Robot arm.md');
    expect(resolve('diagram.png')).toBe('img/diagram.png');
    expect(resolve('Data.v2')).toBe('Data.v2.md');
    expect(resolve('Missing')).toBeNull();
  });

  it('treats an empty link path as the source file', async () => {
    const { resolve } = await setup(['Index.md']);
    expect(resolve('', 'Index.md')).toBe('Index.md');
  });

  it('prefers the source folder, then the shortest path, then exact case', async () => {
    const { resolve } = await setup([
      'A/Note.md',
      'B/C/Note.md',
      'B/Note.md',
      'Case/note.md',
      'Case2/Deep/Note.md',
    ]);
    expect(resolve('Note', 'B/C/Other.md')).toBe('B/C/Note.md');
    expect(resolve('Note', 'X/Other.md')).toBe('A/Note.md');
    expect(resolve('note', 'X/Other.md')).toBe('Case/note.md');
  });

  it('resolves paths relative to the source, from the root, and by suffix', async () => {
    const { resolve } = await setup([
      'Projects/Arm/Kinematics.md',
      'Projects/Arm/Notes/Log.md',
      'Other/Log.md',
    ]);
    expect(resolve('Notes/Log', 'Projects/Arm/Kinematics.md')).toBe('Projects/Arm/Notes/Log.md');
    expect(resolve('../Kinematics', 'Projects/Arm/Notes/Log.md')).toBe('Projects/Arm/Kinematics.md');
    expect(resolve('Other/Log')).toBe('Other/Log.md');
    expect(resolve('Arm/Kinematics')).toBe('Projects/Arm/Kinematics.md');
  });

  it('follows renames', async () => {
    const { vault, resolve } = await setup(['Old name.md']);
    await vault.rename(vault.getFileByPath('Old name.md')!, 'New name.md');
    expect(resolve('Old name')).toBeNull();
    expect(resolve('New name')).toBe('New name.md');
  });
});
