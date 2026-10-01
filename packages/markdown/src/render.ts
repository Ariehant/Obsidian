/**
 * Markdown → DOM for the reading view: render to HTML, sanitise, then run the built-in
 * post-processors (callouts, math, links, images, embeds).
 */
import { getFrontMatterInfo, parseYaml } from '@basalt/core';
import { setIcon } from '@basalt/ui';
import createDOMPurify, { type Config, type DOMPurify } from 'dompurify';
import { markdownToHtml, type HtmlOptions } from './html';
import { getLinkpath, isExternalUrl, parseLinktext } from './links';
import { finishRenderMath, loadMathJax, renderMath } from './math';
import { renderProperties } from './properties';
import { resolveSubpath } from './sections';

/** A file the host resolved a link to. Structurally compatible with core's `TFile`. */
export interface LinkedFile {
  path: string;
  basename: string;
  extension: string;
}

/** What the renderer needs from the app. Everything is optional; missing pieces degrade. */
export interface RenderHost {
  resolveLink(linkpath: string, sourcePath: string): LinkedFile | null;
  resourceUrl(file: LinkedFile): string;
  readNote(file: LinkedFile): Promise<string>;
}

export interface RenderOptions extends HtmlOptions {
  /** Show frontmatter as a read-only properties block (reading view; not embeds). */
  properties?: boolean;
  /** Vault path of the note being rendered; links resolve relative to it. */
  sourcePath: string;
  host?: RenderHost;
  /** @internal Embed recursion guard. */
  embedStack?: string[];
}

const MAX_EMBED_DEPTH = 5;
export const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp', 'avif']);
export const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'm4a', 'ogg', '3gp', 'flac', 'webm']);
export const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'ogv', 'mov', 'mkv']);

let purifier: DOMPurify | null = null;

const SANITIZE_CONFIG: Config & { RETURN_DOM_FRAGMENT: true } = {
  RETURN_DOM_FRAGMENT: true,
  ADD_TAGS: ['iframe'],
  ADD_ATTR: ['target', 'allow', 'allowfullscreen', 'frameborder', 'scrolling'],
  FORBID_TAGS: ['style', 'script', 'object', 'embed', 'form'],
};

/**
 * DOMPurify silently returns its input when the DOM implementation misbehaves. Rendered
 * notes run with Node access, so verify it on first use and refuse to render otherwise.
 */
function createPurifier(): DOMPurify {
  const p = createDOMPurify(window);
  const probe = document.createElement('div');
  probe.appendChild(
    p.sanitize(
      '<b>ok</b><img onerror="1"><script>1</script><a href="javascript:1">x</a>',
      SANITIZE_CONFIG,
    ) as unknown as Node,
  );
  const html = probe.innerHTML;
  if (!p.isSupported || /onerror|<script|javascript:/i.test(html) || !html.includes('<b>ok</b>')) {
    throw new Error('HTML sanitizer is not working in this environment; refusing to render untrusted HTML.');
  }
  return p;
}

/** Sanitises untrusted HTML into a fragment (plugin API `sanitizeHTMLToDom`). */
export function sanitizeHTMLToDom(html: string): DocumentFragment {
  purifier ??= createPurifier();
  return purifier.sanitize(html, SANITIZE_CONFIG) as unknown as DocumentFragment;
}

/** Renders Markdown into `el` (appending). Resolves once async post-processing is done. */
export async function renderMarkdown(source: string, el: HTMLElement, options: RenderOptions): Promise<void> {
  if (options.properties) {
    const info = getFrontMatterInfo(source);
    if (info.exists) {
      let fm: unknown = null;
      try {
        fm = parseYaml(info.frontmatter);
      } catch {
        /* invalid YAML: no properties block */
      }
      if (fm && typeof fm === 'object' && !Array.isArray(fm) && Object.keys(fm).length) {
        renderProperties(
          el.createDiv({ cls: 'mod-header', attr: { 'data-line': '0' } }),
          fm as Record<string, unknown>,
        );
      }
    }
  }
  const html = markdownToHtml(source, { sections: true, ...options });
  el.appendChild(sanitizeHTMLToDom(html));
  await postProcess(el, options);
}

async function postProcess(el: HTMLElement, options: RenderOptions): Promise<void> {
  processCallouts(el);
  processLinks(el, options);
  processImages(el, options);
  await Promise.all([processMath(el), processEmbeds(el, options)]);
}

function processCallouts(el: HTMLElement): void {
  for (const callout of Array.from(el.querySelectorAll<HTMLElement>('.callout'))) {
    const icon = callout.querySelector<HTMLElement>(':scope > .callout-title > .callout-icon');
    if (icon) setIcon(icon, callout.dataset.calloutIcon ?? 'pencil');
    const fold = callout.querySelector<HTMLElement>(':scope > .callout-title > .callout-fold');
    if (!fold) continue;
    setIcon(fold, 'chevron-down');
    const title = callout.querySelector<HTMLElement>(':scope > .callout-title')!;
    const content = callout.querySelector<HTMLElement>(':scope > .callout-content');
    title.addEventListener('click', (ev) => {
      if ((ev.target as HTMLElement).closest('a')) return;
      const collapsed = !callout.classList.contains('is-collapsed');
      callout.classList.toggle('is-collapsed', collapsed);
      if (content) content.style.display = collapsed ? 'none' : '';
    });
  }
}

function processLinks(el: HTMLElement, options: RenderOptions): void {
  const host = options.host;
  if (!host) return;
  for (const a of Array.from(el.querySelectorAll<HTMLAnchorElement>('a.internal-link'))) {
    const linkpath = getLinkpath(a.dataset.href ?? '');
    if (linkpath && !host.resolveLink(linkpath, options.sourcePath)) a.classList.add('is-unresolved');
  }
}

/** `alt|300` or `alt|300x200` sets the image size, as in wikilink embeds. */
function applySize(img: HTMLImageElement | HTMLVideoElement, spec: string | null): string | null {
  if (!spec) return null;
  const m = /^(.*?)\|?(\d+)(?:x(\d+))?$/.exec(spec);
  if (!m) return spec;
  img.setAttribute('width', m[2]!);
  if (m[3]) img.setAttribute('height', m[3]);
  return m[1] ?? '';
}

function processImages(el: HTMLElement, options: RenderOptions): void {
  for (const img of Array.from(el.querySelectorAll<HTMLImageElement>('img'))) {
    if (img.closest('.internal-embed')) continue;
    const alt = img.getAttribute('alt');
    if (alt && /\|\d+(x\d+)?$/.test(alt)) img.setAttribute('alt', applySize(img, alt) ?? '');
    const src = img.getAttribute('src') ?? '';
    if (!src || isExternalUrl(src) || !options.host) continue;
    let linkpath = src;
    try {
      linkpath = decodeURI(src);
    } catch {
      /* keep as written */
    }
    const file = options.host.resolveLink(linkpath, options.sourcePath);
    if (file) {
      img.setAttribute('src', options.host.resourceUrl(file));
    } else {
      // Don't let a relative URL resolve against the app's own files.
      img.removeAttribute('src');
      img.setAttribute('data-src', src);
      img.classList.add('is-unresolved');
    }
  }
}

async function processMath(el: HTMLElement): Promise<void> {
  const nodes = Array.from(el.querySelectorAll<HTMLElement>('.math'));
  if (!nodes.length) return;
  await loadMathJax();
  for (const node of nodes) {
    const tex = node.textContent ?? '';
    const display = node.classList.contains('math-block');
    node.empty();
    node.appendChild(renderMath(tex, display));
    node.classList.add('is-loaded');
  }
  finishRenderMath(el.ownerDocument);
}

async function processEmbeds(el: HTMLElement, options: RenderOptions): Promise<void> {
  const embeds = Array.from(el.querySelectorAll<HTMLElement>('span.internal-embed:not(.is-loaded)'));
  await Promise.all(embeds.map((embed) => renderEmbed(embed, options)));
}

async function renderEmbed(embed: HTMLElement, options: RenderOptions): Promise<void> {
  const linktext = embed.getAttribute('src') ?? '';
  const alt = embed.getAttribute('alt');
  const { path, subpath } = parseLinktext(linktext);
  const host = options.host;
  const file = host && path ? host.resolveLink(path, options.sourcePath) : null;
  embed.classList.add('is-loaded');

  if (!host || !file) {
    embed.classList.add('file-embed', 'mod-empty', 'is-unresolved');
    embed.createDiv({ cls: 'file-embed-title', text: `"${path || linktext}" could not be found.` });
    return;
  }

  const ext = file.extension.toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) {
    embed.classList.add('image-embed', 'media-embed');
    const img = embed.createEl('img', { attr: { src: host.resourceUrl(file), alt: file.basename } });
    const rest = applySize(img, alt);
    if (rest) img.setAttribute('alt', rest);
    return;
  }
  if (VIDEO_EXTENSIONS.has(ext) && !(ext === 'webm' && AUDIO_EXTENSIONS.has(ext) && !alt)) {
    embed.classList.add('video-embed', 'media-embed');
    const video = embed.createEl('video', { attr: { src: host.resourceUrl(file), controls: '' } });
    applySize(video, alt);
    return;
  }
  if (AUDIO_EXTENSIONS.has(ext)) {
    embed.classList.add('audio-embed', 'media-embed');
    embed.createEl('audio', { attr: { src: host.resourceUrl(file), controls: '' } });
    return;
  }
  if (ext === 'pdf') {
    embed.classList.add('pdf-embed');
    embed.createEl('iframe', {
      attr: { src: host.resourceUrl(file) + (subpath || ''), width: '100%', height: '600' },
    });
    return;
  }
  if (ext !== 'md') {
    embed.classList.add('file-embed', 'mod-generic');
    embed.createDiv({ cls: 'file-embed-title', text: file.basename + '.' + file.extension });
    return;
  }

  const stack = options.embedStack ?? [options.sourcePath];
  embed.classList.add('markdown-embed', 'inline-embed', 'is-loaded');
  embed.setAttribute('data-embed-path', file.path);
  if (stack.length > MAX_EMBED_DEPTH || stack.includes(file.path + subpath)) {
    embed.createDiv({ cls: 'markdown-embed-content', text: 'Embed depth limit reached.' });
    return;
  }
  const title = embed.createDiv({ cls: 'markdown-embed-title', text: alt ?? file.basename });
  if (!alt) title.hide();
  const link = embed.createDiv({
    cls: 'markdown-embed-link',
    attr: { 'aria-label': 'Open link', 'data-href': linktext },
  });
  setIcon(link, 'link');
  const content = embed.createDiv('markdown-embed-content');
  const view = content.createDiv('markdown-preview-view markdown-rendered');

  let source = await host.readNote(file);
  if (subpath) {
    const range = resolveSubpath(source, subpath);
    if (!range) {
      view.createDiv({
        cls: 'markdown-embed-error',
        text: `Unable to find section ${subpath} in ${file.basename}`,
      });
      return;
    }
    source = source.slice(range.from, range.to);
  }
  await renderMarkdown(source, view, {
    ...options,
    sourcePath: file.path,
    embedStack: [...stack, file.path + subpath],
  });
}
