// DOMPurify doesn't work under happy-dom (it fails open); use jsdom like DOMPurify's own suite.
// @vitest-environment jsdom
import { installDomHelpers } from '@basalt/ui';
import { beforeAll, describe, expect, it } from 'vitest';
import { renderMarkdown, resolveSubpath, sanitizeHTMLToDom, type LinkedFile, type RenderHost } from '../src';

beforeAll(() => installDomHelpers(window as Window & typeof globalThis));

function file(path: string): LinkedFile {
  const name = path.split('/').pop()!;
  const dot = name.lastIndexOf('.');
  return { path, basename: name.slice(0, dot), extension: name.slice(dot + 1) };
}

const NOTES: Record<string, string> = {
  'Robot arm.md':
    '# Robot arm\n\nIntro.\n\n## Joints\n\nSix joints. ^joints\n\n## Links\n\nSee ![[Robot arm]].\n',
  'Loop.md': 'Loop: ![[Loop]]\n',
};
const FILES = [...Object.keys(NOTES), 'attachments/diagram.png', 'clip.mp4'].map(file);

const host: RenderHost = {
  resolveLink: (linkpath) =>
    FILES.find(
      (f) =>
        f.path === linkpath ||
        f.basename === linkpath ||
        f.path.endsWith('/' + linkpath) ||
        f.basename + '.' + f.extension === linkpath,
    ) ?? null,
  resourceUrl: (f) => `app://local/vault/${f.path}`,
  readNote: async (f) => NOTES[f.path] ?? '',
};

async function render(md: string): Promise<HTMLElement> {
  const el = document.createElement('div');
  await renderMarkdown(md, el, { sourcePath: 'Index.md', host });
  return el;
}

describe('sanitizeHTMLToDom', () => {
  it('strips scripts, event handlers and javascript: URLs', () => {
    const div = document.createElement('div');
    div.appendChild(
      sanitizeHTMLToDom(
        '<p onclick="x()">a</p><script>alert(1)</script><a href="javascript:alert(1)">b</a><img src=x onerror="y()">',
      ),
    );
    expect(div.querySelector('script')).toBeNull();
    expect(div.querySelector('[onclick], [onerror]')).toBeNull();
    expect(div.querySelector('a')!.getAttribute('href')).toBeNull();
  });

  it('keeps the attributes the renderer relies on', () => {
    const div = document.createElement('div');
    div.appendChild(
      sanitizeHTMLToDom(
        '<a data-href="Note" href="Note" class="internal-link" target="_blank">x</a><span class="internal-embed" src="a.png" alt="100"></span><input type="checkbox" checked>',
      ),
    );
    expect(div.querySelector('a')!.getAttribute('data-href')).toBe('Note');
    expect(div.querySelector('span')!.getAttribute('src')).toBe('a.png');
    expect(div.querySelector('input')!.hasAttribute('checked')).toBe(true);
  });
});

describe('renderMarkdown', () => {
  it('wraps top-level blocks in sections', async () => {
    const el = await render('# H\n\npara\n\n- a\n');
    expect(Array.from(el.children).map((c) => c.className)).toEqual(['el-h1', 'el-p', 'el-ul']);
  });

  it('adds callout icons and toggles folding', async () => {
    const el = await render('> [!warning]- Careful\n> body\n');
    const callout = el.querySelector<HTMLElement>('.callout')!;
    expect(callout.querySelector('.callout-icon svg.lucide-triangle-alert')).not.toBeNull();
    expect(callout.classList.contains('is-collapsed')).toBe(true);
    callout.querySelector<HTMLElement>('.callout-title')!.click();
    expect(callout.classList.contains('is-collapsed')).toBe(false);
    expect(callout.querySelector<HTMLElement>('.callout-content')!.style.display).toBe('');
  });

  it('marks unresolved internal links', async () => {
    const el = await render('[[Robot arm]] [[Missing note]] [[#Local]]');
    const links = Array.from(el.querySelectorAll('a.internal-link'));
    expect(links.map((a) => a.classList.contains('is-unresolved'))).toEqual([false, true, false]);
  });

  it('resolves image embeds with a size and local Markdown images', async () => {
    const el = await render('![[diagram.png|300]] ![local](attachments/diagram.png)');
    const [embedImg, mdImg] = Array.from(el.querySelectorAll('img'));
    expect(embedImg!.getAttribute('src')).toBe('app://local/vault/attachments/diagram.png');
    expect(embedImg!.getAttribute('width')).toBe('300');
    expect(embedImg!.closest('.internal-embed')!.classList.contains('image-embed')).toBe(true);
    expect(mdImg!.getAttribute('src')).toBe('app://local/vault/attachments/diagram.png');
  });

  it('embeds video and reports missing files', async () => {
    const el = await render('![[clip.mp4]]\n\n![[Nowhere]]');
    expect(el.querySelector('video')?.getAttribute('src')).toBe('app://local/vault/clip.mp4');
    expect(el.querySelector('.internal-embed.is-unresolved')?.textContent).toContain(
      '"Nowhere" could not be found.',
    );
  });

  it('embeds a heading section and a block of another note', async () => {
    const el = await render('![[Robot arm#Joints]]\n\n![[Robot arm#^joints]]');
    const [section, block] = Array.from(
      el.querySelectorAll<HTMLElement>('.markdown-embed .markdown-preview-view'),
    );
    expect(section!.querySelector('h2')!.textContent).toBe('Joints');
    expect(section!.textContent).not.toContain('Intro.');
    expect(section!.textContent).not.toContain('See');
    expect(block!.textContent!.trim()).toBe('Six joints.');
  });

  it('stops embed recursion', async () => {
    const el = await render('![[Loop]]');
    expect(el.textContent).toContain('Embed depth limit reached.');
    // Nested whole-note embeds: Robot arm embeds itself inside its "Links" section.
    const el2 = await render('![[Robot arm]]');
    expect(el2.querySelectorAll('.markdown-embed').length).toBe(2);
  });
});

describe('resolveSubpath', () => {
  const src =
    '# A\n\ntext\n\n## B\n\nb text\n\n### C\n\nc\n\n## D\n\n- item ^li\n- other\n\n| t |\n|---|\n\n^tbl\n';
  const slice = (sub: string) => {
    const r = resolveSubpath(src, sub);
    return r ? src.slice(r.from, r.to) : null;
  };

  it('finds heading sections, nested headings and missing headings', () => {
    expect(slice('#B')).toBe('## B\n\nb text\n\n### C\n\nc');
    expect(slice('#A#C')).toBe('### C\n\nc');
    expect(slice('#b')).toBe('## B\n\nb text\n\n### C\n\nc');
    expect(slice('#Nope')).toBeNull();
  });

  it('finds blocks, list items and standalone ids after a block', () => {
    expect(slice('#^li')).toBe('- item ^li');
    expect(slice('#^tbl')).toBe('| t |\n|---|');
    expect(slice('#^missing')).toBeNull();
  });
});

describe('math', () => {
  it('renders inline and block TeX with MathJax', async () => {
    const el = await render('Inline $x^2$.\n\n$$\n\\tau = J^T F\n$$\n');
    const inline = el.querySelector('.math-inline')!;
    const block = el.querySelector('.math-block')!;
    expect(inline.classList.contains('is-loaded')).toBe(true);
    expect(inline.querySelector('mjx-container svg')).not.toBeNull();
    expect(block.querySelector('mjx-container')?.getAttribute('display')).toBe('true');
  });

  it('shows TeX errors instead of throwing', async () => {
    const el = await render('$\\frac{1}{$');
    expect(el.querySelector('.math-inline')!.textContent).not.toBe('');
  });
});
