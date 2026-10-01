/**
 * Live Preview: Markdown syntax is hidden unless the selection touches it, and some
 * constructs render in place.
 *
 * - Inline (ViewPlugin, visible ranges only): formatting marks, links, wikilinks, bullets,
 *   task checkboxes, rules, images, embeds and inline math.
 * - Blocks (StateField, since CodeMirror only allows block widgets from state): tables,
 *   callouts and math blocks render through the reading-view renderer until the selection
 *   enters them.
 */
import { syntaxTree } from '@codemirror/language';
import { Facet, StateField, type EditorState, type Range } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import {
  finishRenderMath,
  IMAGE_EXTENSIONS,
  isExternalUrl,
  linktextDisplay,
  loadMathJax,
  markdownToHtml,
  parseCalloutHeader,
  parseLinktext,
  renderMath,
  renderProperties,
  sanitizeHTMLToDom,
  type LinkedFile,
} from '@basalt/markdown';
import { parseYaml, stringifyYaml } from '@basalt/core/src/frontmatter';
import type { SyntaxNode } from '@lezer/common';
import type { SuggestHost } from './suggest';

/** What the editor needs from the app to resolve and render links. */
export interface EditorHost {
  resolveLink(linkpath: string): LinkedFile | null;
  resourceUrl(file: LinkedFile): string;
  openLink(linktext: string, newLeaf: boolean): void;
  /** Renders Markdown with the reading-view pipeline (embeds, links, math). */
  renderMarkdown(source: string, el: HTMLElement): Promise<void>;
  /** Link and tag suggestions; autocomplete is off without it. */
  suggest?: SuggestHost;
  /** Saves pasted or dropped files into the vault; resolves to the text to insert for each. */
  saveAttachments?(files: File[]): Promise<string[]>;
}

export const editorHost = Facet.define<EditorHost | null, EditorHost | null>({
  combine: (values) => values.find((v) => v) ?? null,
});

// ---------------------------------------------------------------------------------------
// Helpers

function touches(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((r) => r.from <= to && r.to >= from);
}

function lineTouched(state: EditorState, pos: number): boolean {
  const line = state.doc.lineAt(pos);
  return touches(state, line.from, line.to);
}

const hide = Decoration.replace({});

async function renderInto(view: EditorView, source: string, el: HTMLElement): Promise<void> {
  const host = view.state.facet(editorHost);
  if (host) await host.renderMarkdown(source, el);
  else el.appendChild(sanitizeHTMLToDom(markdownToHtml(source)));
}

// ---------------------------------------------------------------------------------------
// Widgets

class BulletWidget extends WidgetType {
  override eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'list-bullet';
    return span;
  }
}

class CheckboxWidget extends WidgetType {
  constructor(
    readonly status: string,
    readonly pos: number,
  ) {
    super();
  }
  override eq(other: CheckboxWidget): boolean {
    return other.status === this.status && other.pos === this.pos;
  }
  toDOM(view: EditorView): HTMLElement {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'task-list-item-checkbox';
    input.checked = this.status !== ' ';
    input.dataset.task = this.status;
    input.addEventListener('mousedown', (ev) => ev.preventDefault());
    input.addEventListener('click', (ev) => {
      ev.preventDefault();
      const next = this.status === ' ' ? 'x' : ' ';
      view.dispatch({ changes: { from: this.pos + 1, to: this.pos + 2, insert: next } });
    });
    return input;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

class HrWidget extends WidgetType {
  override eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    return document.createElement('hr');
  }
}

class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
  ) {
    super();
  }
  override eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt;
  }
  toDOM(): HTMLElement {
    const img = document.createElement('img');
    img.src = this.src;
    const m = /^(.*?)\|?(\d+)(?:x(\d+))?$/.exec(this.alt);
    if (m && /\d$/.test(this.alt) && this.alt.includes('|')) {
      img.alt = m[1] ?? '';
      img.width = Number(m[2]);
      if (m[3]) img.height = Number(m[3]);
    } else {
      img.alt = this.alt;
    }
    return img;
  }
}

class MathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly display: boolean,
  ) {
    super();
  }
  override eq(other: MathWidget): boolean {
    return other.tex === this.tex && other.display === this.display;
  }
  toDOM(): HTMLElement {
    const el = document.createElement(this.display ? 'div' : 'span');
    el.className = `math math-${this.display ? 'block' : 'inline'} cm-embed-block`;
    el.textContent = this.tex;
    void loadMathJax().then(() => {
      el.textContent = '';
      el.appendChild(renderMath(this.tex, this.display));
      el.classList.add('is-loaded');
      finishRenderMath(el.ownerDocument);
    });
    return el;
  }
}

/** Renders a slice of Markdown (an embed or a whole block) with the reading-view pipeline. */
class RenderedWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly from: number,
    readonly block: boolean,
    readonly cls: string,
  ) {
    super();
  }
  override eq(other: RenderedWidget): boolean {
    return other.source === this.source && other.block === this.block && other.from === this.from;
  }
  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement(this.block ? 'div' : 'span');
    el.className = `cm-embed-block ${this.cls}`;
    const inner = el.appendChild(document.createElement(this.block ? 'div' : 'span'));
    inner.className = 'markdown-rendered';
    void renderInto(view, this.source, inner);
    el.addEventListener('mousedown', (ev) => {
      const target = ev.target as HTMLElement;
      if (target.closest('a, input, .callout-title, .markdown-embed-link')) return;
      ev.preventDefault();
      // Clicking the rendered block moves the cursor into it, which reveals the source.
      view.dispatch({ selection: { anchor: this.from } });
      view.focus();
    });
    return el;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

// ---------------------------------------------------------------------------------------
// Block widgets (state field)

interface BlockRange {
  from: number;
  to: number;
}

/** Editable properties for the frontmatter block; edits rewrite the YAML. */
class PropertiesWidget extends WidgetType {
  constructor(
    readonly yaml: string,
    readonly from: number,
    readonly to: number,
  ) {
    super();
  }
  override eq(other: PropertiesWidget): boolean {
    return other.yaml === this.yaml && other.from === this.from && other.to === this.to;
  }
  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement('div');
    el.className = 'cm-embed-block cm-properties';
    let data: Record<string, unknown> = {};
    try {
      const parsed = this.yaml.trim() ? parseYaml(this.yaml) : {};
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed;
    } catch {
      /* the field never builds this widget for invalid YAML */
    }
    renderProperties(el, data, {
      onChange: (next) => {
        const body = Object.keys(next).length ? stringifyYaml(next) : '';
        view.dispatch({ changes: { from: this.from, to: this.to, insert: `---\n${body}---` } });
      },
    });
    // Clicking the heading shows the YAML source.
    el.querySelector('.metadata-properties-heading')?.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      view.dispatch({ selection: { anchor: this.from + 4 } });
      view.focus();
    });
    return el;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

function validYaml(yaml: string): boolean {
  try {
    const parsed = yaml.trim() ? parseYaml(yaml) : {};
    return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function blockCandidates(state: EditorState): Array<{ node: SyntaxNode; kind: string }> {
  const out: Array<{ node: SyntaxNode; kind: string }> = [];
  for (let node = syntaxTree(state).topNode.firstChild; node; node = node.nextSibling) {
    if (node.name === 'Frontmatter') out.push({ node, kind: 'properties' });
    else if (node.name === 'Table' || node.name === 'MathBlock') out.push({ node, kind: node.name });
    else if (node.name === 'Blockquote') {
      const firstLine = state.doc.lineAt(node.from);
      const text = state.doc.sliceString(firstLine.from, firstLine.to).replace(/^\s*>\s?/, '');
      if (parseCalloutHeader(text)) out.push({ node, kind: 'callout' });
    }
  }
  return out;
}

function buildBlocks(state: EditorState): { decorations: DecorationSet; ranges: BlockRange[] } {
  const ranges: Range<Decoration>[] = [];
  const covered: BlockRange[] = [];
  for (const { node, kind } of blockCandidates(state)) {
    const from = state.doc.lineAt(node.from).from;
    const to = state.doc.lineAt(node.to).to;
    if (touches(state, from, to)) continue;
    const source = state.doc.sliceString(from, to);
    let widget: WidgetType;
    if (kind === 'properties') {
      const content = node.getChild('FrontmatterContent');
      const yaml = content ? state.doc.sliceString(content.from, content.to) : '';
      if (!validYaml(yaml)) continue;
      widget = new PropertiesWidget(yaml, node.from, node.to);
    } else if (kind === 'MathBlock') {
      const tex = source.trim().replace(/^\$\$/, '').replace(/\$\$$/, '').trim();
      widget = new MathWidget(tex, true);
    } else {
      widget = new RenderedWidget(source, from, true, kind === 'Table' ? 'cm-table-widget' : 'cm-callout');
    }
    ranges.push(Decoration.replace({ widget, block: true }).range(from, to));
    covered.push({ from, to });
  }
  return { decorations: Decoration.set(ranges, true), ranges: covered };
}

const blockWidgets = StateField.define<{ decorations: DecorationSet; ranges: BlockRange[] }>({
  create: (state) => buildBlocks(state),
  update(value, tr) {
    if (tr.docChanged || tr.selection || syntaxTree(tr.startState) !== syntaxTree(tr.state)) {
      return buildBlocks(tr.state);
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.decorations),
});

// ---------------------------------------------------------------------------------------
// Inline decorations (view plugin)

function internalLinkDecorations(
  state: EditorState,
  node: SyntaxNode,
  host: EditorHost | null,
  out: Range<Decoration>[],
): void {
  const path = node.getChild('InternalLinkPath');
  const alias = node.getChild('InternalLinkAlias');
  const target = path ? state.doc.sliceString(path.from, path.to).trim() : '';
  const { path: linkpath } = parseLinktext(target);
  const unresolved = !!host && !!linkpath && !host.resolveLink(linkpath);

  for (const child of node.getChildren('InternalLinkMark')) out.push(hide.range(child.from, child.to));
  const shown = alias ?? path;
  if (alias && path) out.push(hide.range(path.from, alias.from));
  if (!shown) return;
  const attrs = { 'data-href': target, class: `cm-underline${unresolved ? ' is-unresolved' : ''}` };
  if (!alias && target.includes('#')) {
    // Show `Note#Heading` as `Note > Heading`, like the reading view.
    out.push(
      Decoration.replace({ widget: new LinkTextWidget(linktextDisplay(target), target, unresolved) }).range(
        shown.from,
        shown.to,
      ),
    );
    return;
  }
  out.push(Decoration.mark({ attributes: attrs }).range(shown.from, shown.to));
}

class LinkTextWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly href: string,
    readonly unresolved: boolean,
  ) {
    super();
  }
  override eq(other: LinkTextWidget): boolean {
    return other.text === this.text && other.href === this.href && other.unresolved === this.unresolved;
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = `cm-hmd-internal-link cm-underline${this.unresolved ? ' is-unresolved' : ''}`;
    span.dataset.href = this.href;
    span.textContent = this.text;
    return span;
  }
  override ignoreEvent(): boolean {
    return false;
  }
}

function buildInline(view: EditorView, blocks: BlockRange[]): DecorationSet {
  const { state } = view;
  const host = state.facet(editorHost);
  const out: Range<Decoration>[] = [];
  const inBlock = (from: number, to: number) => blocks.some((b) => from >= b.from && to <= b.to);

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (ref) => {
        const node = ref.node;
        if (inBlock(node.from, node.to)) return false;
        const active = touches(state, node.from, node.to);
        switch (node.name) {
          case 'HeaderMark': {
            const parent = node.parent?.name ?? '';
            if (!parent.startsWith('ATX') || lineTouched(state, node.from)) return;
            const next = state.doc.sliceString(node.to, node.to + 1);
            out.push(hide.range(node.from, next === ' ' ? node.to + 1 : node.to));
            return;
          }
          case 'Emphasis':
          case 'StrongEmphasis':
          case 'Strikethrough':
          case 'Highlight':
          case 'InlineCode': {
            if (active) return;
            for (let c = node.firstChild; c; c = c.nextSibling) {
              if (/Mark$/.test(c.name)) out.push(hide.range(c.from, c.to));
            }
            return;
          }
          case 'Escape':
            if (!active) out.push(hide.range(node.from, node.from + 1));
            return;
          case 'Link': {
            if (active) return;
            const marks = node.getChildren('LinkMark');
            const close = marks.find((m) => state.doc.sliceString(m.from, m.to) === ']');
            const url = node.getChild('URL');
            if (!marks[0] || !close) return;
            const href = url ? state.doc.sliceString(url.from, url.to).replace(/^<|>$/g, '') : '';
            out.push(hide.range(marks[0].from, marks[0].to));
            out.push(hide.range(close.from, node.to));
            if (close.from > marks[0].to) {
              out.push(
                Decoration.mark({
                  attributes: {
                    'data-href': href,
                    class: isExternalUrl(href) ? 'external-link' : 'cm-underline',
                  },
                }).range(marks[0].to, close.from),
              );
            }
            return false;
          }
          case 'Autolink':
            if (!active) {
              out.push(hide.range(node.from, node.from + 1), hide.range(node.to - 1, node.to));
              out.push(
                Decoration.mark({
                  attributes: { 'data-href': state.doc.sliceString(node.from + 1, node.to - 1) },
                }).range(node.from + 1, node.to - 1),
              );
            }
            return false;
          case 'InternalLink':
            if (!active) internalLinkDecorations(state, node, host, out);
            return false;
          case 'Embed': {
            if (active) return false;
            const raw = state.doc.sliceString(node.from, node.to);
            const path = node.getChild('InternalLinkPath');
            const target = path ? state.doc.sliceString(path.from, path.to) : '';
            const file = host?.resolveLink(parseLinktext(target).path) ?? null;
            if (file && IMAGE_EXTENSIONS.has(file.extension.toLowerCase())) {
              const alias = node.getChild('InternalLinkAlias');
              const alt = alias ? `|${state.doc.sliceString(alias.from, alias.to)}` : '';
              out.push(
                Decoration.replace({ widget: new ImageWidget(host!.resourceUrl(file), alt) }).range(
                  node.from,
                  node.to,
                ),
              );
            } else {
              out.push(
                Decoration.replace({ widget: new RenderedWidget(raw, node.from, false, 'cm-embed') }).range(
                  node.from,
                  node.to,
                ),
              );
            }
            return false;
          }
          case 'Image': {
            if (active) return false;
            const url = node.getChild('URL');
            if (!url) return false;
            let src = state.doc.sliceString(url.from, url.to).replace(/^<|>$/g, '');
            if (!isExternalUrl(src) && host) {
              let linkpath = src;
              try {
                linkpath = decodeURI(src);
              } catch {
                /* keep */
              }
              const file = host.resolveLink(linkpath);
              if (!file) return false;
              src = host.resourceUrl(file);
            }
            const marks = node.getChildren('LinkMark');
            const alt = marks.length >= 2 ? state.doc.sliceString(marks[0]!.to, marks[1]!.from) : '';
            out.push(Decoration.replace({ widget: new ImageWidget(src, alt) }).range(node.from, node.to));
            return false;
          }
          case 'InlineMath': {
            if (active) return false;
            const marks = node.getChildren('MathMark');
            if (marks.length < 2) return false;
            const tex = state.doc.sliceString(marks[0]!.to, marks[1]!.from);
            const display = marks[0]!.to - marks[0]!.from === 2;
            out.push(Decoration.replace({ widget: new MathWidget(tex, display) }).range(node.from, node.to));
            return false;
          }
          case 'QuoteMark': {
            if (lineTouched(state, node.from)) return;
            const next = state.doc.sliceString(node.to, node.to + 1);
            out.push(hide.range(node.from, next === ' ' ? node.to + 1 : node.to));
            return;
          }
          case 'ListMark': {
            const item = node.parent;
            const isTask = item?.getChild('Task');
            const bullet = /^[-*+]$/.test(state.doc.sliceString(node.from, node.to));
            if (touches(state, node.from, node.to + 1)) return;
            if (isTask) {
              const next = state.doc.sliceString(node.to, node.to + 1);
              out.push(hide.range(node.from, next === ' ' ? node.to + 1 : node.to));
            } else if (bullet) {
              out.push(Decoration.replace({ widget: new BulletWidget() }).range(node.from, node.to));
            }
            return;
          }
          case 'TaskMarker': {
            if (touches(state, node.from, node.to)) return;
            const status = state.doc.sliceString(node.from + 1, node.from + 2);
            out.push(
              Decoration.replace({ widget: new CheckboxWidget(status, node.from) }).range(node.from, node.to),
            );
            return;
          }
          case 'HorizontalRule':
            if (!lineTouched(state, node.from)) {
              out.push(Decoration.replace({ widget: new HrWidget() }).range(node.from, node.to));
            }
            return false;
          default:
            return;
        }
      },
    });
  }
  return Decoration.set(out, true);
}

const inlinePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildInline(view, view.state.field(blockWidgets).ranges);
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.decorations = buildInline(update.view, update.state.field(blockWidgets).ranges);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

/** Opens links: plain click in Live Preview, Ctrl/Cmd-click in source mode. */
export function linkClickHandler(requireModifier: boolean) {
  return EditorView.domEventHandlers({
    mousedown(ev, view) {
      if (ev.button !== 0 && ev.button !== 1) return false;
      const target = (ev.target as HTMLElement).closest<HTMLElement>('[data-href]');
      if (!target || !view.contentDOM.contains(target)) return false;
      const mod = ev.metaKey || ev.ctrlKey;
      if (requireModifier && !mod) return false;
      const href = target.dataset.href ?? '';
      if (!href) return false;
      ev.preventDefault();
      if (isExternalUrl(href)) window.open(href, '_blank');
      else view.state.facet(editorHost)?.openLink(href, mod || ev.button === 1);
      return true;
    },
  });
}

/** The Live Preview extension set. */
export function livePreview() {
  return [
    blockWidgets,
    inlinePreview,
    linkClickHandler(false),
    EditorView.editorAttributes.of({ class: 'is-live-preview' }),
  ];
}
