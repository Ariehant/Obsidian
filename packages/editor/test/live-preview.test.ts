// jsdom: the fallback renderer for block widgets uses DOMPurify, which fails under happy-dom.
// @vitest-environment jsdom
import { installDomHelpers } from '@basalt/ui';
import type { LinkedFile } from '@basalt/markdown';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createEditorState, EditorView, setLivePreview, type EditorHost } from '../src';

beforeAll(() => installDomHelpers(window as Window & typeof globalThis));

const files: LinkedFile[] = [{ path: 'Robot arm.md', basename: 'Robot arm', extension: 'md' }];
const opened: string[] = [];
const host: EditorHost = {
  resolveLink: (p) => files.find((f) => f.basename === p) ?? null,
  resourceUrl: (f) => `app://local/${f.path}`,
  openLink: (l) => opened.push(l),
  renderMarkdown: async (src, el) => {
    el.textContent = `rendered:${src.split('\n')[0]}`;
  },
};

let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
  opened.length = 0;
});

function open(doc: string, cursor = doc.length, live = true): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  view = new EditorView({ parent, state: createEditorState({ doc, host, livePreview: live }) });
  view.dispatch({ selection: { anchor: cursor } });
  return view;
}

const line = (v: EditorView, n: number) => v.contentDOM.querySelectorAll<HTMLElement>('.cm-line')[n]!;

describe('token classes', () => {
  it('adds theme-compatible line and token classes', () => {
    const v = open('# Title\n\n> quote [[Robot arm]] #tag\n\n- item\n', 0, false);
    expect(line(v, 0).classList.contains('HyperMD-header-1')).toBe(true);
    expect(v.contentDOM.querySelector('.cm-formatting-header-1')?.textContent).toBe('#');
    expect(line(v, 2).classList.contains('HyperMD-quote')).toBe(true);
    expect(v.contentDOM.querySelector('.cm-hmd-internal-link')?.textContent).toBe('Robot arm');
    expect(v.contentDOM.querySelector('.cm-hashtag-end')?.textContent).toBe('tag');
    expect(line(v, 4).classList.contains('HyperMD-list-line-1')).toBe(true);
  });
});

describe('Live Preview', () => {
  it('hides formatting away from the cursor and reveals it on contact', () => {
    const src = '**bold** and `code`\n\nend';
    const v = open(src);
    expect(line(v, 0).textContent).toBe('bold and code');
    v.dispatch({ selection: { anchor: 3 } });
    expect(line(v, 0).textContent).toBe('**bold** and code');
  });

  it('hides heading marks unless the cursor is on the line', () => {
    const v = open('## Heading\n\ntext');
    expect(line(v, 0).textContent).toBe('Heading');
    v.dispatch({ selection: { anchor: 5 } });
    expect(line(v, 0).textContent).toBe('## Heading');
  });

  it('shows wikilink aliases and marks unresolved links', () => {
    const v = open('[[Robot arm|the arm]] and [[Missing]]\n\nx');
    expect(line(v, 0).textContent).toBe('the arm and Missing');
    const links = Array.from(v.contentDOM.querySelectorAll<HTMLElement>('[data-href]'));
    expect(links.map((l) => [l.dataset.href, l.classList.contains('is-unresolved')])).toEqual([
      ['Robot arm', false],
      ['Missing', true],
    ]);
  });

  it('opens links on click', () => {
    const v = open('[[Robot arm]]\n\nx');
    const link = v.contentDOM.querySelector<HTMLElement>('[data-href]')!;
    link.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    expect(opened).toEqual(['Robot arm']);
  });

  it('renders task checkboxes that toggle the document', () => {
    const v = open('- [ ] todo\n\nx');
    const box = v.contentDOM.querySelector<HTMLInputElement>('input.task-list-item-checkbox')!;
    expect(box.checked).toBe(false);
    box.click();
    expect(v.state.doc.toString()).toBe('- [x] todo\n\nx');
  });

  it('replaces bullets with a widget', () => {
    const v = open('- one\n\nx');
    expect(v.contentDOM.querySelector('.list-bullet')).not.toBeNull();
    // The space after the marker stays, between the bullet widget and the text.
    expect(line(v, 0).textContent).toBe(' one');
  });

  it('renders tables and callouts as blocks until the cursor enters', () => {
    const src = '| a | b |\n|---|---|\n| 1 | 2 |\n\n> [!note] Hi\n> body\n\nend';
    const v = open(src);
    const widgets = Array.from(v.contentDOM.querySelectorAll<HTMLElement>('.cm-embed-block'));
    expect(widgets.map((w) => w.textContent)).toEqual(['rendered:| a | b |', 'rendered:> [!note] Hi']);
    v.dispatch({ selection: { anchor: 2 } });
    expect(v.contentDOM.querySelectorAll('.cm-embed-block')).toHaveLength(1);
    expect(line(v, 0).textContent).toBe('| a | b |');
  });

  it('switches to source mode without losing the document', () => {
    const v = open('**bold**\n\nx');
    setLivePreview(v, false);
    expect(line(v, 0).textContent).toBe('**bold**');
    expect(v.dom.classList.contains('is-source-mode')).toBe(true);
    setLivePreview(v, true);
    expect(line(v, 0).textContent).toBe('bold');
  });
});

describe('properties widget', () => {
  it('renders frontmatter as properties and writes edits back as YAML', () => {
    const v = open('---\nstatus: draft\ntags: [a]\n---\n# Body\n\nx');
    const status = v.contentDOM.querySelector<HTMLInputElement>(
      '[data-property-key="status"] .metadata-input',
    )!;
    expect(status.value).toBe('draft');
    status.value = 'done';
    status.dispatchEvent(new Event('blur'));
    expect(v.state.doc.toString()).toBe('---\nstatus: done\ntags:\n  - a\n---\n# Body\n\nx');
  });

  it('shows the YAML source when the cursor is inside or the YAML is invalid', () => {
    const v = open('---\nstatus: draft\n---\nx', 5);
    expect(v.contentDOM.querySelector('.metadata-container')).toBeNull();
    const bad = open('---\nkey: [unclosed\n---\nx');
    expect(bad.contentDOM.querySelector('.metadata-container')).toBeNull();
  });
});
