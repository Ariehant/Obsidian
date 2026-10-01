import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// The real parser: these are integration tests of cache + resolver + file manager.
import { computeMetadata } from '../../markdown/src/metadata';
import { App, FileSystemAdapter, Vault, type MetadataStore, type StoredMetadata } from '../src';

let dir: string;
let app: App;

async function write(rel: string, data: string) {
  const full = path.join(dir, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, data);
}
const read = (rel: string) => fs.readFile(path.join(dir, rel), 'utf8');

function memoryStore(): MetadataStore & { data: Map<string, StoredMetadata> } {
  const data = new Map<string, StoredMetadata>();
  return {
    data,
    get: async (p) => data.get(p) ?? null,
    set: async (p, e) => void data.set(p, e),
    delete: async (p) => void data.delete(p),
    keys: async () => [...data.keys()],
  };
}

async function open(store: MetadataStore | null = null, parse = vi.fn(computeMetadata)) {
  const vault = new Vault(new FileSystemAdapter(dir));
  app = new App(vault, { parser: { parse }, store });
  await vault.load();
  await app.metadataCache.initialize();
  return { vault, cache: app.metadataCache, fm: app.fileManager, parse };
}

/** Waits until the cache has processed pending changes. */
async function settle() {
  await app.vault.whenIdle();
  await vi.waitFor(() => expect(app.metadataCache.isResolved()).toBe(true));
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'basalt-meta-'));
  await write(
    'Index.md',
    '# Index\n\n[[Robot arm]] [[Robot arm#Joints|joints]] [[Missing]] ![[diagram.png]] #home\n',
  );
  await write(
    'Projects/Robot arm.md',
    '---\ntags: [robotics]\n---\n# Robot arm\n\n## Joints\n\nSee [kin](../Kinematics.md).\n',
  );
  await write('Kinematics.md', 'Links back to [[Index]]. #robotics\n');
  await write('img/diagram.png', 'png');
});

afterEach(async () => {
  app?.metadataCache.dispose();
  app?.vault.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('MetadataCache', () => {
  it('indexes notes and resolves links', async () => {
    const { cache, vault } = await open();
    expect(cache.getCache('Index.md')?.headings?.[0]?.heading).toBe('Index');
    expect(cache.resolvedLinks['Index.md']).toEqual({ 'Projects/Robot arm.md': 2, 'img/diagram.png': 1 });
    expect(cache.unresolvedLinks['Index.md']).toEqual({ Missing: 1 });
    expect(cache.resolvedLinks['Projects/Robot arm.md']).toEqual({ 'Kinematics.md': 1 });
    expect(cache.getTags()).toEqual({ '#home': 1, '#robotics': 2 });

    const arm = vault.getFileByPath('Projects/Robot arm.md')!;
    expect([...cache.getBacklinksForFile(arm).keys()]).toEqual(['Index.md']);
    expect(cache.fileToLinktext(arm, 'Index.md')).toBe('Robot arm');
  });

  it('reuses stored metadata for unchanged notes', async () => {
    const store = memoryStore();
    const first = await open(store);
    expect(first.parse).toHaveBeenCalledTimes(3);
    first.cache.dispose();
    first.vault.close();

    await write('Kinematics.md', 'Changed. [[Robot arm]]\n');
    const second = await open(store);
    expect(second.parse).toHaveBeenCalledTimes(1);
    expect(second.cache.resolvedLinks['Kinematics.md']).toEqual({ 'Projects/Robot arm.md': 1 });
  });

  it('follows edits, creations and deletions', async () => {
    const { cache, vault } = await open();
    const changed = vi.fn();
    cache.on('changed', changed);

    await vault.create('Missing.md', '# Now exists');
    await settle();
    expect(cache.resolvedLinks['Index.md']?.['Missing.md']).toBe(1);
    expect(cache.unresolvedLinks['Index.md']).toEqual({});

    await vault.modify(vault.getFileByPath('Kinematics.md')!, 'No links any more.');
    await settle();
    expect(cache.resolvedLinks['Kinematics.md']).toEqual({});
    expect(changed).toHaveBeenCalled();

    const deleted = vi.fn();
    cache.on('deleted', deleted);
    await vault.delete(vault.getFileByPath('Missing.md')!);
    await settle();
    expect(deleted).toHaveBeenCalledTimes(1);
    expect(cache.unresolvedLinks['Index.md']).toEqual({ Missing: 1 });
  });
});

describe('FileManager', () => {
  it('rewrites wikilinks, embeds, subpaths and aliases when a note is renamed', async () => {
    const { fm, vault } = await open();
    await fm.renameFile(vault.getFileByPath('Projects/Robot arm.md')!, 'Projects/Manipulator.md');
    expect(await read('Index.md')).toBe(
      '# Index\n\n[[Manipulator]] [[Manipulator#Joints|joints]] [[Missing]] ![[diagram.png]] #home\n',
    );
    await settle();
    expect(app.metadataCache.resolvedLinks['Index.md']?.['Projects/Manipulator.md']).toBe(2);
  });

  it('rewrites Markdown links relative to the source and links inside the moved note', async () => {
    const { fm, vault } = await open();
    await fm.renameFile(vault.getFileByPath('Kinematics.md')!, 'Theory/Kinematics.md');
    expect(await read('Projects/Robot arm.md')).toContain('See [kin](../Theory/Kinematics.md).');

    await fm.renameFile(vault.getFileByPath('Index.md')!, 'Home.md');
    expect(await read('Theory/Kinematics.md')).toBe('Links back to [[Home]]. #robotics\n');
  });

  it('rewrites links to files inside a moved folder and embeds of attachments', async () => {
    const { fm, vault } = await open();
    await fm.renameFile(vault.getFolderByPath('img')!, 'assets');
    expect(await read('Index.md')).toContain('![[diagram.png]]');
    await fm.renameFile(vault.getFileByPath('assets/diagram.png')!, 'assets/arm-diagram.png');
    expect(await read('Index.md')).toContain('![[arm-diagram.png]]');

    // A shorter-path file with the new name would win name resolution, so the link
    // must spell out the full path to keep pointing at the moved file.
    await write('z/arm.png', 'other');
    await vault.whenIdle();
    await fm.renameFile(vault.getFileByPath('assets/arm-diagram.png')!, 'assets/arm.png');
    expect(await read('Index.md')).toContain('![[assets/arm.png]]');
    await settle();
    expect(app.metadataCache.resolvedLinks['Index.md']?.['assets/arm.png']).toBe(1);
  });

  it('updates frontmatter links and leaves files alone when updates are off', async () => {
    await write('Meta.md', '---\nrelated: "[[Kinematics]]"\n---\nBody [[Kinematics]]\n');
    const { fm, vault } = await open();
    await fm.renameFile(vault.getFileByPath('Kinematics.md')!, 'Kin.md');
    expect(await read('Meta.md')).toBe('---\nrelated: "[[Kin]]"\n---\nBody [[Kin]]\n');

    vault.setConfig('alwaysUpdateLinks', false);
    await settle();
    await fm.renameFile(vault.getFileByPath('Kin.md')!, 'Kin2.md');
    expect(await read('Meta.md')).toContain('[[Kin]]');
  });

  it('generates links in the configured format', async () => {
    const { fm, vault } = await open();
    const arm = vault.getFileByPath('Projects/Robot arm.md')!;
    expect(fm.generateMarkdownLink(arm, 'Index.md')).toBe('[[Robot arm]]');
    expect(fm.generateMarkdownLink(arm, 'Index.md', '#Joints', 'j')).toBe('[[Robot arm#Joints|j]]');
    vault.setConfig('newLinkFormat', 'relative');
    vault.setConfig('useMarkdownLinks', true);
    expect(fm.generateMarkdownLink(arm, 'Kinematics.md')).toBe('[Robot arm](Projects/Robot%20arm.md)');
    expect(fm.generateMarkdownLink(vault.getFileByPath('Kinematics.md')!, 'Projects/Robot arm.md')).toBe(
      '[Kinematics](../Kinematics.md)',
    );
  });

  it('edits frontmatter in place', async () => {
    const { fm, vault } = await open();
    await fm.processFrontMatter(vault.getFileByPath('Projects/Robot arm.md')!, (f) => {
      f.tags.push('arm');
      f.status = 'draft';
    });
    expect(await read('Projects/Robot arm.md')).toBe(
      '---\ntags:\n  - robotics\n  - arm\nstatus: draft\n---\n# Robot arm\n\n## Joints\n\nSee [kin](../Kinematics.md).\n',
    );
    await fm.processFrontMatter(vault.getFileByPath('Kinematics.md')!, (f) => (f.created = '2026-10-01'));
    expect(await read('Kinematics.md')).toBe(
      '---\ncreated: 2026-10-01\n---\nLinks back to [[Index]]. #robotics\n',
    );
  });

  it('finds free attachment paths per the attachment folder setting', async () => {
    const { fm, vault } = await open();
    expect(await fm.getAvailablePathForAttachment('diagram.png', 'Index.md')).toBe('diagram.png');
    vault.setConfig('attachmentFolderPath', 'img');
    expect(await fm.getAvailablePathForAttachment('diagram.png', 'Index.md')).toBe('img/diagram 1.png');
    vault.setConfig('attachmentFolderPath', './attachments');
    expect(await fm.getAvailablePathForAttachment('a.png', 'Projects/Robot arm.md')).toBe(
      'Projects/attachments/a.png',
    );
    expect(vault.getFolderByPath('Projects/attachments')).not.toBeNull();
  });
});
