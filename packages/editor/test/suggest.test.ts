// @vitest-environment jsdom
import { acceptCompletion, currentCompletions, startCompletion } from '@codemirror/autocomplete';
import type { LinkedFile } from '@basalt/markdown';
import { installDomHelpers } from '@basalt/ui';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createEditorState, EditorView, type EditorHost } from '../src';

beforeAll(() => {
  installDomHelpers(window as Window & typeof globalThis);
  // jsdom has no layout; the completion tooltip measures text ranges.
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});

/** CodeMirror ignores accepts within `interactionDelay` (75 ms) of the list opening. */
const accept = async (v: EditorView) => {
  await new Promise((r) => setTimeout(r, 100));
  acceptCompletion(v);
};

const f = (path: string): LinkedFile => {
  const name = path.split('/').pop()!;
  const dot = name.lastIndexOf('.');
  return { path, basename: name.slice(0, dot), extension: name.slice(dot + 1) };
};
const FILES = [f('Projects/Robot arm.md'), f('Kinematics.md'), f('attachments/diagram.png'), f('Farm.md')];

const host: EditorHost = {
  resolveLink: () => null,
  resourceUrl: () => '',
  openLink: () => {},
  renderMarkdown: async () => {},
  suggest: {
    files: () => FILES.map((file) => ({ file, aliases: file.basename === 'Kinematics' ? ['FK'] : [] })),
    linktext: (file) => (file.extension === 'md' ? file.basename : `${file.basename}.${file.extension}`),
    headings: (lp) => (lp === 'Robot arm' ? ['Robot arm', 'Joints', 'Wrist limits'] : []),
    blocks: () => [{ id: 'base', text: 'Base joint' }],
    tags: () => ['#robotics', '#robotics/arm', '#reading'],
  },
};

let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
});

function open(doc: string): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  view = new EditorView({ parent, state: createEditorState({ doc, host, livePreview: false }) });
  view.dispatch({ selection: { anchor: doc.length } });
  return view;
}

async function complete(doc: string): Promise<string[]> {
  const v = open(doc);
  startCompletion(v);
  await vi.waitFor(() => expect(currentCompletions(v.state).length).toBeGreaterThan(0), { timeout: 2000 });
  return currentCompletions(v.state).map((c) => c.label);
}

describe('link and tag completion', () => {
  it('suggests files by fuzzy name, including aliases', async () => {
    // Word-start matches rank above mid-word ones (diagram.png also matches a…r…m).
    expect((await complete('See [[arm')).slice(0, 2)).toEqual(['Robot arm', 'Farm']);
    expect(await complete('See [[fk')).toEqual(['FK']);
    expect((await complete('![[diag'))[0]).toBe('diagram.png');
  });

  it('inserts the link text and closes the link', async () => {
    const v = open('See [[rob');
    startCompletion(v);
    await vi.waitFor(() => expect(currentCompletions(v.state).length).toBeGreaterThan(0));
    await accept(v);
    expect(v.state.doc.toString()).toBe('See [[Robot arm]]');
    expect(v.state.selection.main.head).toBe(v.state.doc.length);
  });

  it('inserts an alias link for alias matches', async () => {
    const v = open('[[FK');
    startCompletion(v);
    await vi.waitFor(() => expect(currentCompletions(v.state).length).toBeGreaterThan(0));
    await accept(v);
    expect(v.state.doc.toString()).toBe('[[Kinematics|FK]]');
  });

  it('suggests headings and blocks of the target note', async () => {
    expect(await complete('[[Robot arm#wri')).toEqual(['Wrist limits']);
    const v = open('[[Robot arm#^ba');
    startCompletion(v);
    await vi.waitFor(() => expect(currentCompletions(v.state).length).toBeGreaterThan(0));
    await accept(v);
    expect(v.state.doc.toString()).toBe('[[Robot arm#^base]]');
  });

  it('suggests tags after #', async () => {
    expect(await complete('Tagged #rob')).toEqual(['robotics', 'robotics/arm']);
  });

  it('stays quiet after an alias pipe', () => {
    const v = open('[[Robot arm|al');
    startCompletion(v);
    expect(currentCompletions(v.state)).toEqual([]);
  });
});
