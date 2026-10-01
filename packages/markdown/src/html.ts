/**
 * Markdown → HTML string, from the Lezer tree.
 *
 * Two flavours:
 * - `commonmark`: plain CommonMark output, graded against the official spec suite.
 * - `obsidian` (default): GFM + OFM, with the classes and attributes the reading view,
 *   themes and plugins expect (`internal-link`, `callout`, `task-list-item`, …).
 *
 * The result is an untrusted HTML string (it passes raw HTML through); callers must
 * sanitise it before inserting it into a document (see `render.ts`).
 */
import type { SyntaxNode, Tree } from '@lezer/common';
import { decodeHTML } from 'entities';
import { calloutType, defaultCalloutTitle, parseCalloutHeader } from './callouts';
import { isExternalUrl, linktextDisplay } from './links';
import { commonmarkParser, obsidianParser } from './syntax';

export interface HtmlOptions {
  flavor?: 'obsidian' | 'commonmark';
  /** When false, a single newline in a paragraph renders as `<br>`. Obsidian default: false. */
  strictLineBreaks?: boolean;
  /** Wrap each top-level block in `<div class="el-…">` (reading-view sections). */
  sections?: boolean;
}

export interface RenderedHtml {
  html: string;
  tree: Tree;
}

const escapeMap: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
export const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => escapeMap[c]!);

const Escapable = /\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g;
const unescapeMd = (s: string) => decodeHTML(s.replace(Escapable, '$1'));

/** Percent-encodes a URL the way CommonMark reference renderers do, keeping valid escapes. */
export function normalizeUrl(url: string): string {
  let out = '';
  for (let i = 0; i < url.length; i++) {
    const ch = url[i]!;
    if (ch === '%' && /^[0-9a-f]{2}$/i.test(url.slice(i + 1, i + 3))) out += ch;
    else if (/[A-Za-z0-9;/?:@&=+$,\-_.!~*'()#]/.test(ch)) out += ch;
    else {
      const cp = url.codePointAt(i)!;
      const s = String.fromCodePoint(cp);
      if (cp > 0xffff) i++;
      out += encodeURIComponent(s).replace(/%[0-9a-f]{2}/gi, (m) => m.toUpperCase());
    }
  }
  return out;
}

/** Reference label normalisation: trim, collapse whitespace, case-fold. */
export function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase();
}

interface LinkDef {
  url: string;
  title: string | null;
}

const HEADING_LEVEL: Record<string, number> = {
  ATXHeading1: 1,
  ATXHeading2: 2,
  ATXHeading3: 3,
  ATXHeading4: 4,
  ATXHeading5: 5,
  ATXHeading6: 6,
  SetextHeading1: 1,
  SetextHeading2: 2,
};

/** Block node types whose output is empty (they only feed metadata or other nodes). */
const SILENT_BLOCKS = new Set(['LinkReference', 'Frontmatter', 'ObsidianCommentBlock', 'FootnoteDefinition']);

function sectionTag(node: SyntaxNode, html: string): string {
  if (HEADING_LEVEL[node.name]) return `h${HEADING_LEVEL[node.name]}`;
  switch (node.name) {
    case 'Paragraph':
      return 'p';
    case 'BulletList':
      return 'ul';
    case 'OrderedList':
      return 'ol';
    case 'FencedCode':
    case 'CodeBlock':
      return 'pre';
    case 'Blockquote':
      return html.startsWith('<div') ? 'div' : 'blockquote';
    case 'Table':
      return 'table';
    case 'HorizontalRule':
      return 'hr';
    default:
      return 'div';
  }
}

class Renderer {
  private readonly obsidian: boolean;
  private readonly breaks: boolean;
  private readonly refs = new Map<string, LinkDef>();
  private readonly footnoteDefs = new Map<string, SyntaxNode>();
  private readonly footnoteOrder: Array<{ label: string; id: number; inline: SyntaxNode | null }> = [];
  private readonly footnoteIds = new Map<string, number>();
  /** Set after markers that swallow the whitespace following them (line starts, `>`). */
  private skipSpace = false;

  constructor(
    private readonly src: string,
    private readonly tree: Tree,
    private readonly options: HtmlOptions,
  ) {
    this.obsidian = options.flavor !== 'commonmark';
    this.breaks = this.obsidian && !options.strictLineBreaks;
  }

  render(): string {
    this.collectDefinitions();
    const top = this.tree.topNode;
    let out = '';
    for (let child = top.firstChild; child; child = child.nextSibling) {
      const html = this.block(child);
      if (!html) continue;
      out += this.options.sections
        ? `<div class="el-${sectionTag(child, html)}" data-line="${this.lineNumber(child.from)}">${html}</div>\n`
        : html;
    }
    return out + this.footnotesSection();
  }

  private slice(from: number, to: number): string {
    return this.src.slice(from, to);
  }

  private collectDefinitions(): void {
    const cursor = this.tree.cursor();
    do {
      if (cursor.name === 'LinkReference') {
        const node = cursor.node;
        const label = node.getChild('LinkLabel');
        if (!label) continue;
        const key = normalizeLabel(this.slice(label.from + 1, label.to - 1));
        if (!key || this.refs.has(key)) continue;
        const url = node.getChild('URL');
        const title = node.getChild('LinkTitle');
        this.refs.set(key, {
          url: url ? this.destination(url) : '',
          title: title ? this.title(title) : null,
        });
      } else if (cursor.name === 'FootnoteDefinition') {
        const label = cursor.node.getChild('FootnoteLabel');
        if (label) {
          const key = this.slice(label.from, label.to);
          if (!this.footnoteDefs.has(key)) this.footnoteDefs.set(key, cursor.node);
        }
      }
    } while (cursor.next());
  }

  // -------------------------------------------------------------------------------------
  // Blocks

  private blocks(parent: SyntaxNode, skip: SyntaxNode | null = null): string {
    let out = '';
    for (let child = parent.firstChild; child; child = child.nextSibling) {
      // SyntaxNode objects aren't identity-stable; compare by position.
      if (skip && child.from === skip.from && child.to === skip.to && child.name === skip.name) continue;
      out += this.block(child);
    }
    return out;
  }

  private block(node: SyntaxNode): string {
    const level = HEADING_LEVEL[node.name];
    if (level) return this.heading(node, level);
    if (SILENT_BLOCKS.has(node.name)) return '';

    switch (node.name) {
      case 'Paragraph':
        return `<p>${this.paragraphContent(node, node.from, node.to)}</p>\n`;
      case 'Blockquote':
        return this.blockquote(node);
      case 'BulletList':
      case 'OrderedList':
        return this.list(node);
      case 'FencedCode':
      case 'CodeBlock':
        return this.code(node);
      case 'HTMLBlock':
      case 'CommentBlock':
      case 'ProcessingInstructionBlock':
        return this.rawBlock(node);
      case 'HorizontalRule':
        return '<hr />\n';
      case 'Table':
        return this.table(node);
      case 'MathBlock':
        return `<div class="math math-block">${escapeHtml(this.mathSource(node))}</div>\n`;
      case 'QuoteMark':
      case 'ListMark':
        return '';
      case 'Task':
        return `<p>${this.paragraphContent(node, node.getChild('TaskMarker')!.to, node.to)}</p>\n`;
      default:
        return this.blocks(node);
    }
  }

  private heading(node: SyntaxNode, level: number): string {
    let from = node.from;
    let to = node.to;
    const marks = node.getChildren('HeaderMark');
    if (node.name.startsWith('ATX')) {
      const open = marks[0];
      if (open) from = open.to;
      const close = marks.length > 1 ? marks[marks.length - 1]! : null;
      if (close) to = close.from;
    } else if (marks.length) {
      to = marks[marks.length - 1]!.from;
    }
    const content = this.inline(node, from, to).trim();
    const id = this.obsidian ? ` data-heading="${escapeHtml(this.plainText(content))}"` : '';
    return `<h${level}${id}>${content}</h${level}>\n`;
  }

  /** Paragraph-like inline content with trailing whitespace removed. */
  private paragraphContent(node: SyntaxNode, from: number, to: number): string {
    while (to > from && /[ \t\n]/.test(this.src[to - 1]!)) to--;
    // Hidden trailing syntax (block ids, comments) can leave a dangling space.
    return this.inline(node, from, to).replace(/[ \t]+$/, '');
  }

  private blockquote(node: SyntaxNode): string {
    if (this.obsidian) {
      const callout = this.callout(node);
      if (callout !== null) return callout;
    }
    return `<blockquote>\n${this.blocks(node)}</blockquote>\n`;
  }

  private callout(node: SyntaxNode): string | null {
    let first = node.firstChild;
    while (first && first.name === 'QuoteMark') first = first.nextSibling;
    if (!first || first.name !== 'Paragraph') return null;

    const nl = this.src.indexOf('\n', first.from);
    const lineEnd = nl === -1 || nl > first.to ? first.to : nl;
    const header = parseCalloutHeader(this.slice(first.from, lineEnd));
    if (!header) return null;

    const { type, icon } = calloutType(header.name);
    const title =
      header.titleOffset === -1
        ? escapeHtml(defaultCalloutTitle(header.name))
        : this.inline(first, first.from + header.titleOffset, lineEnd).trim();

    let content = '';
    if (lineEnd < first.to) {
      const rest = this.paragraphContent(first, lineEnd + 1, first.to).trim();
      if (rest) content += `<p>${rest}</p>\n`;
    }
    content += this.blocks(node, first);

    const foldable = header.fold !== '';
    const collapsed = header.fold === '-';
    const cls = ['callout', foldable ? 'is-collapsible' : '', collapsed ? 'is-collapsed' : '']
      .filter(Boolean)
      .join(' ');
    return (
      `<div data-callout-metadata="${escapeHtml(header.metadata)}" data-callout-fold="${header.fold}" ` +
      `data-callout="${escapeHtml(header.name)}" data-callout-type="${type}" data-callout-icon="${icon}" class="${cls}">` +
      `<div class="callout-title"><div class="callout-icon"></div><div class="callout-title-inner">${title}</div>` +
      (foldable ? '<div class="callout-fold"></div>' : '') +
      `</div>` +
      `<div class="callout-content"${collapsed ? ' style="display: none;"' : ''}>\n${content}</div></div>\n`
    );
  }

  private hasBlankLine(from: number, to: number): boolean {
    return /\n[ \t]*(?:>[ \t]*)*\n/.test(this.slice(from, to));
  }

  private isTight(list: SyntaxNode): boolean {
    const items = list.getChildren('ListItem');
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      if (i > 0 && this.hasBlankLine(items[i - 1]!.to, item.from)) return false;
      let prev: SyntaxNode | null = null;
      for (let c = item.firstChild; c; c = c.nextSibling) {
        if (c.name === 'ListMark' || c.name === 'QuoteMark') continue;
        if (prev && this.hasBlankLine(prev.to, c.from)) return false;
        prev = c;
      }
    }
    return true;
  }

  private list(node: SyntaxNode): string {
    const ordered = node.name === 'OrderedList';
    const tight = this.isTight(node);
    let open = '<ul>';
    if (ordered) {
      const firstMark = node.firstChild?.getChild('ListMark');
      const start = firstMark ? parseInt(this.slice(firstMark.from, firstMark.to), 10) : 1;
      open = start !== 1 ? `<ol start="${start}">` : '<ol>';
    }
    let hasTasks = false;
    let items = '';
    for (let item = node.firstChild; item; item = item.nextSibling) {
      if (item.name !== 'ListItem') continue;
      const { html, task } = this.listItem(item, tight);
      hasTasks ||= task;
      items += html;
    }
    if (this.obsidian && hasTasks) open = open.replace(/^<(ul|ol)/, '<$1 class="contains-task-list"');
    return `${open}\n${items}</${ordered ? 'ol' : 'ul'}>\n`;
  }

  private listItem(item: SyntaxNode, tight: boolean): { html: string; task: boolean } {
    const children: SyntaxNode[] = [];
    for (let c = item.firstChild; c; c = c.nextSibling) {
      if (c.name !== 'ListMark' && c.name !== 'QuoteMark') children.push(c);
    }

    let attrs = '';
    let task = false;
    const parts: string[] = [];
    for (const child of children) {
      if (child.name === 'Task') {
        const marker = child.getChild('TaskMarker')!;
        const status = this.src[marker.from + 1]!;
        task = true;
        const checked = status !== ' ';
        const line = this.lineNumber(child.from);
        attrs = ` data-task="${escapeHtml(status)}" data-line="${line}" class="task-list-item${checked ? ' is-checked' : ''}"`;
        const box = `<input data-task="${escapeHtml(status)}" type="checkbox" class="task-list-item-checkbox"${checked ? ' checked' : ''} />`;
        const content = this.paragraphContent(child, marker.to, child.to).replace(/^\s+/, '');
        parts.push(tight ? `${box}${content}` : `<p>${box}${content}</p>\n`);
      } else if (tight && child.name === 'Paragraph') {
        parts.push(this.paragraphContent(child, child.from, child.to));
      } else {
        parts.push(this.block(child));
      }
    }
    if (!parts.length) return { html: `<li${attrs}></li>\n`, task };
    const body = parts.map((p) => (p.endsWith('\n') ? `\n${p}` : p)).join('');
    return { html: `<li${attrs}>${body}</li>\n`, task };
  }

  private lineStarts: number[] | null = null;

  /** 0-based line of an offset (binary search over precomputed line starts). */
  private lineNumber(pos: number): number {
    if (!this.lineStarts) {
      this.lineStarts = [0];
      for (let i = this.src.indexOf('\n'); i !== -1; i = this.src.indexOf('\n', i + 1))
        this.lineStarts.push(i + 1);
    }
    const starts = this.lineStarts;
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  private lineStartOf(pos: number): number {
    return this.src.lastIndexOf('\n', pos - 1) + 1;
  }

  /**
   * Text of a code block, one entry per source line. Lezer already strips container
   * prefixes (list indentation, `>`) from `CodeText`; `extraIndent` removes up to that
   * many further leading spaces (a fenced block's own indentation).
   */
  private codeLines(node: SyntaxNode, bodyFrom: number, bodyTo: number, extraIndent: number): string[] {
    if (bodyFrom >= bodyTo) return [];
    const texts = node.getChildren('CodeText');
    const first = texts[0];
    const containerPrefix = first ? first.from - this.lineStartOf(first.from) : 0;
    const lines: string[] = [];
    let lineStart = bodyFrom;
    while (lineStart <= bodyTo) {
      let lineEnd = this.src.indexOf('\n', lineStart);
      if (lineEnd === -1 || lineEnd > bodyTo) lineEnd = bodyTo;
      let text = '';
      let found = false;
      for (const t of texts) {
        const from = Math.max(t.from, lineStart);
        const to = Math.min(t.to, lineEnd);
        if (from < to) {
          text += this.slice(from, to);
          found = true;
        }
      }
      if (!found) {
        // Blank line: keep whitespace beyond the container's indentation.
        const raw = this.slice(lineStart, lineEnd);
        text = /^[ \t]*$/.test(raw) ? raw.slice(Math.min(containerPrefix, raw.length)) : '';
      }
      if (extraIndent) text = text.replace(new RegExp(`^ {0,${extraIndent}}`), '');
      lines.push(text);
      if (lineEnd >= bodyTo) break;
      lineStart = lineEnd + 1;
    }
    return lines;
  }

  private code(node: SyntaxNode): string {
    let lang = '';
    let lines: string[];
    if (node.name === 'FencedCode') {
      const marks = node.getChildren('CodeMark');
      const info = node.getChild('CodeInfo');
      if (info) lang = unescapeMd(this.slice(info.from, info.to)).split(/\s+/)[0] ?? '';
      const openEnd = this.src.indexOf('\n', marks[0]!.to);
      const bodyFrom = openEnd === -1 || openEnd >= node.to ? node.to : openEnd + 1;
      const closing = marks.length > 1 ? marks[marks.length - 1]! : null;
      let bodyTo = closing ? this.src.lastIndexOf('\n', closing.from) : node.to;
      if (!closing && this.src[bodyTo - 1] === '\n') bodyTo--;
      if (bodyTo < bodyFrom) bodyTo = bodyFrom;
      // The fence's own indentation: its column minus the container prefix lezer strips.
      const first = node.getChild('CodeText');
      const containerPrefix = first ? first.from - this.lineStartOf(first.from) : 0;
      const fenceColumn = marks[0]!.from - this.lineStartOf(marks[0]!.from);
      const extraIndent = first ? Math.max(0, fenceColumn - containerPrefix) : 0;
      lines = this.codeLines(node, bodyFrom, bodyTo, extraIndent);
    } else {
      lines = this.codeLines(node, this.lineStartOf(node.from), node.to, 0);
      while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
    }
    const body = lines.length ? escapeHtml(lines.join('\n') + '\n') : '';
    const cls = lang ? ` class="language-${escapeHtml(lang)}"` : '';
    return `<pre><code${cls}>${body}</code></pre>\n`;
  }

  /** Column at which the content of `node`'s container starts, on `node`'s first line. */
  private containerColumn(node: SyntaxNode): number {
    const parent = node.parent;
    if (!parent || parent.name === 'Document') return 0;
    if (parent.name === 'ListItem') {
      const mark = parent.getChild('ListMark');
      if (!mark) return 0;
      let spaces = 0;
      while (this.src[mark.to + spaces] === ' ') spaces++;
      if (spaces > 4 || spaces === 0) spaces = 1;
      return mark.to + spaces - this.lineStartOf(mark.to);
    }
    return 0;
  }

  /** Raw HTML block: source lines with blockquote/list prefixes removed. */
  private rawBlock(node: SyntaxNode): string {
    const indent = this.containerColumn(node);
    const out: string[] = [];
    // Keep the block's own leading indentation on its first line.
    let pos =
      node.parent?.name === 'Blockquote'
        ? node.from
        : Math.min(node.from, this.lineStartOf(node.from) + indent);
    let first = true;
    while (pos <= node.to) {
      let end = this.src.indexOf('\n', pos);
      if (end === -1 || end > node.to) end = node.to;
      out.push(first ? this.slice(pos, end) : this.stripContainerPrefix(node, pos, end, indent));
      first = false;
      if (end >= node.to) break;
      pos = end + 1;
    }
    return out.join('\n') + '\n';
  }

  private stripContainerPrefix(node: SyntaxNode, from: number, to: number, indent: number): string {
    let pos = from;
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (c.name === 'QuoteMark' && c.from >= from && c.to <= to) {
        pos = c.to;
        if (this.src[pos] === ' ') pos++;
      }
    }
    let removed = 0;
    while (removed < indent && pos < to && this.src[pos] === ' ') {
      pos++;
      removed++;
    }
    return this.slice(pos, to);
  }

  private table(node: SyntaxNode): string {
    const delimiterRow = node.getChildren('TableDelimiter')[0];
    const aligns = delimiterRow
      ? this.slice(delimiterRow.from, delimiterRow.to)
          .replace(/^\s*\|/, '')
          .replace(/\|\s*$/, '')
          .split('|')
          .map((cell) => {
            const c = cell.trim();
            const left = c.startsWith(':');
            const right = c.endsWith(':');
            return left && right ? 'center' : right ? 'right' : left ? 'left' : '';
          })
      : [];
    const row = (r: SyntaxNode, tag: 'th' | 'td') => {
      const cells = r.getChildren('TableCell');
      const count = Math.max(aligns.length, 1);
      let out = '<tr>\n';
      for (let i = 0; i < count; i++) {
        const cell = cells[i];
        const align = aligns[i] ? ` style="text-align: ${aligns[i]};"` : '';
        const content = cell ? this.inline(cell, cell.from, cell.to).trim() : '';
        out += `<${tag}${align}>${content}</${tag}>\n`;
      }
      return out + '</tr>\n';
    };
    const header = node.getChild('TableHeader');
    const rows = node.getChildren('TableRow');
    let html = '<table>\n';
    if (header) html += `<thead>\n${row(header, 'th')}</thead>\n`;
    if (rows.length) html += `<tbody>\n${rows.map((r) => row(r, 'td')).join('')}</tbody>\n`;
    return html + '</table>\n';
  }

  private mathSource(node: SyntaxNode): string {
    const marks = node.getChildren('MathMark');
    const from = marks[0]?.to ?? node.from;
    const to = marks.length > 1 ? marks[marks.length - 1]!.from : node.to;
    let text = '';
    let pos = from;
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (c.name === 'QuoteMark' && c.from >= from && c.to <= to) {
        text += this.slice(pos, c.from);
        pos = c.to;
      }
    }
    return (text + this.slice(pos, to)).trim();
  }

  // -------------------------------------------------------------------------------------
  // Inline

  private inline(parent: SyntaxNode, from: number, to: number): string {
    let out = '';
    let pos = from;
    this.skipSpace = true;
    for (let child = parent.firstChild; child; child = child.nextSibling) {
      if (child.to <= from) continue;
      if (child.from >= to) break;
      out += this.text(pos, child.from);
      this.skipSpace = false;
      out += this.inlineNode(child);
      pos = child.to;
    }
    out += this.text(pos, to);
    return out;
  }

  private text(from: number, to: number): string {
    if (from >= to) return '';
    let s = this.slice(from, to);
    if (this.skipSpace) s = s.replace(/^[ \t]+/, '');
    this.skipSpace = false;
    s = s.replace(/[ \t]*\n[ \t]*/g, '\n');
    const escaped = escapeHtml(s);
    return this.breaks ? escaped.replace(/\n/g, '<br>\n') : escaped;
  }

  private inlineNode(node: SyntaxNode): string {
    switch (node.name) {
      case 'Emphasis':
        return `<em>${this.inline(node, node.from, node.to)}</em>`;
      case 'StrongEmphasis':
        return `<strong>${this.inline(node, node.from, node.to)}</strong>`;
      case 'Strikethrough':
        return `<del>${this.inline(node, node.from, node.to)}</del>`;
      case 'Highlight':
        return `<mark>${this.inline(node, node.from, node.to)}</mark>`;
      case 'InlineCode':
        return this.inlineCode(node);
      case 'Escape':
        return escapeHtml(this.src[node.from + 1]!);
      case 'Entity': {
        const raw = this.slice(node.from, node.to);
        // Numeric references are limited to 7 decimal / 6 hex digits.
        if (/^&#(?:\d{8,}|[xX][0-9a-fA-F]{7,});$/.test(raw)) return escapeHtml(raw);
        return escapeHtml(decodeHTML(raw));
      }
      case 'HardBreak': {
        this.skipSpace = true;
        return '<br />\n';
      }
      case 'HTMLTag':
      case 'Comment':
      case 'ProcessingInstruction':
        return this.slice(node.from, node.to);
      case 'Autolink':
        return this.autolink(node);
      case 'URL':
        return this.bareUrl(node);
      case 'Link':
        return this.link(node);
      case 'Image':
        return this.image(node);
      case 'InternalLink':
        return this.internalLink(node);
      case 'Embed':
        return this.embed(node);
      case 'Hashtag': {
        const tag = this.slice(node.from, node.to);
        return `<a href="${escapeHtml(tag)}" class="tag" target="_blank" rel="noopener nofollow">${escapeHtml(tag)}</a>`;
      }
      case 'InlineMath': {
        const display = node.getChild('MathMark')!.to - node.from === 2;
        const tex = this.mathSource(node);
        return `<span class="math math-${display ? 'block' : 'inline'}">${escapeHtml(tex)}</span>`;
      }
      case 'FootnoteReference':
        return this.footnoteRef(
          this.slice(node.getChild('FootnoteLabel')!.from, node.getChild('FootnoteLabel')!.to),
          null,
        );
      case 'InlineFootnote':
        return this.footnoteRef(null, node);
      case 'QuoteMark':
        this.skipSpace = true;
        return '';
      case 'BlockId':
      case 'ObsidianComment':
      case 'EmphasisMark':
      case 'StrikethroughMark':
      case 'HighlightMark':
      case 'CodeMark':
      case 'LinkMark':
      case 'HeaderMark':
      case 'TaskMarker':
      case 'TableDelimiter':
      case 'FootnoteMark':
        return '';
      default:
        return this.inline(node, node.from, node.to);
    }
  }

  private inlineCode(node: SyntaxNode): string {
    const marks = node.getChildren('CodeMark');
    const from = marks[0]!.to;
    const to = marks[marks.length - 1]!.from;
    let text = '';
    let pos = from;
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (c.name === 'QuoteMark' && c.from >= from && c.to <= to) {
        text += this.slice(pos, c.from);
        pos = c.to;
      }
    }
    text = (text + this.slice(pos, to)).replace(/\n/g, ' ');
    if (text.length > 2 && text.startsWith(' ') && text.endsWith(' ') && /[^ ]/.test(text)) {
      text = text.slice(1, -1);
    }
    return `<code>${escapeHtml(text)}</code>`;
  }

  private destination(url: SyntaxNode): string {
    let raw = this.slice(url.from, url.to);
    if (raw.startsWith('<') && raw.endsWith('>')) raw = raw.slice(1, -1);
    return unescapeMd(raw);
  }

  private title(title: SyntaxNode): string {
    return unescapeMd(this.slice(title.from + 1, title.to - 1));
  }

  private linkAttrs(url: string, title: string | null): string {
    const t = title !== null ? ` title="${escapeHtml(title)}"` : '';
    if (!this.obsidian) return `href="${escapeHtml(normalizeUrl(url))}"${t}`;
    if (url && !isExternalUrl(url)) {
      // Relative Markdown links point into the vault.
      let target = url;
      try {
        target = decodeURI(url);
      } catch {
        /* keep as written */
      }
      return `data-href="${escapeHtml(target)}" href="${escapeHtml(target)}" class="internal-link" target="_blank" rel="noopener nofollow"${t}`;
    }
    return `href="${escapeHtml(normalizeUrl(url))}" class="external-link" target="_blank" rel="noopener nofollow"${t}`;
  }

  /** Splits a Link/Image node into its text range and destination. */
  private linkParts(node: SyntaxNode) {
    const marks = node.getChildren('LinkMark');
    const open = marks[0]!;
    const close = marks.find((m) => this.slice(m.from, m.to) === ']');
    const textFrom = open.to;
    const textTo = close ? close.from : node.to;
    const url = node.getChild('URL');
    const title = node.getChild('LinkTitle');
    const label = node.getChild('LinkLabel');
    const hasParens = marks.some((m) => this.slice(m.from, m.to) === '(');

    let def: LinkDef | null;
    if (hasParens) {
      def = { url: url ? this.destination(url) : '', title: title ? this.title(title) : null };
    } else {
      const labelText =
        label && label.to - label.from > 2
          ? this.slice(label.from + 1, label.to - 1)
          : this.slice(textFrom, textTo);
      def = this.refs.get(normalizeLabel(labelText)) ?? null;
    }
    return { textFrom, textTo, def, label };
  }

  private link(node: SyntaxNode): string {
    const { textFrom, textTo, def, label } = this.linkParts(node);
    const text = this.inline(node, textFrom, textTo);
    if (!def) {
      const rest = label ? escapeHtml(unescapeMd(this.slice(label.from, label.to))) : '';
      return `[${text}]${rest}`;
    }
    return `<a ${this.linkAttrs(def.url, def.title)}>${text}</a>`;
  }

  private image(node: SyntaxNode): string {
    const { textFrom, textTo, def, label } = this.linkParts(node);
    const alt = this.plainText(this.inline(node, textFrom, textTo));
    if (!def) {
      const rest = label ? escapeHtml(unescapeMd(this.slice(label.from, label.to))) : '';
      return `![${escapeHtml(alt)}]${rest}`;
    }
    const t = def.title !== null ? ` title="${escapeHtml(def.title)}"` : '';
    return `<img src="${escapeHtml(normalizeUrl(def.url))}" alt="${escapeHtml(alt)}"${t} />`;
  }

  private plainText(html: string): string {
    return decodeHTML(html.replace(/<img [^>]*?alt="([^"]*)"[^>]*>/g, '$1').replace(/<[^>]*>/g, ''));
  }

  private autolink(node: SyntaxNode): string {
    const inner = this.slice(node.from + 1, node.to - 1);
    const isEmail = !/^[a-z][a-z0-9+.-]{1,31}:/i.test(inner);
    const href = isEmail ? `mailto:${inner}` : inner;
    const extra = this.obsidian ? ' class="external-link" target="_blank" rel="noopener nofollow"' : '';
    return `<a href="${escapeHtml(normalizeUrl(href))}"${extra}>${escapeHtml(inner)}</a>`;
  }

  private bareUrl(node: SyntaxNode): string {
    const text = this.slice(node.from, node.to);
    let href = text;
    if (/^www\./i.test(text)) href = `http://${text}`;
    else if (!/^[a-z][a-z0-9+.-]*:/i.test(text) && text.includes('@')) href = `mailto:${text}`;
    return `<a href="${escapeHtml(normalizeUrl(href))}" class="external-link" target="_blank" rel="noopener nofollow">${escapeHtml(text)}</a>`;
  }

  private wikilinkParts(node: SyntaxNode) {
    const path = node.getChild('InternalLinkPath');
    const alias = node.getChild('InternalLinkAlias');
    const target = path ? this.slice(path.from, path.to).trim() : '';
    return { target, alias: alias ? this.slice(alias.from, alias.to).trim() : null };
  }

  private internalLink(node: SyntaxNode): string {
    const { target, alias } = this.wikilinkParts(node);
    const text = alias ?? linktextDisplay(target);
    return `<a data-href="${escapeHtml(target)}" href="${escapeHtml(target)}" class="internal-link" target="_blank" rel="noopener nofollow">${escapeHtml(text)}</a>`;
  }

  private embed(node: SyntaxNode): string {
    const { target, alias } = this.wikilinkParts(node);
    const alt = alias !== null ? ` alt="${escapeHtml(alias)}"` : '';
    return `<span class="internal-embed" src="${escapeHtml(target)}"${alt} tabindex="-1"></span>`;
  }

  // -------------------------------------------------------------------------------------
  // Footnotes

  private footnoteRef(label: string | null, inline: SyntaxNode | null): string {
    let id: number;
    if (label !== null && this.footnoteIds.has(label)) {
      id = this.footnoteIds.get(label)!;
    } else {
      id = this.footnoteOrder.length + 1;
      this.footnoteOrder.push({ label: label ?? '', id, inline });
      if (label !== null) this.footnoteIds.set(label, id);
    }
    if (label !== null && !this.footnoteDefs.has(label)) return escapeHtml(`[^${label}]`);
    return (
      `<sup data-footnote-id="fnref-${id}" class="footnote-ref" id="fnref-${id}">` +
      `<a href="#fn-${id}" class="footnote-link" target="_self" rel="noopener nofollow">${id}</a></sup>`
    );
  }

  private footnotesSection(): string {
    const items: string[] = [];
    // Rendering a footnote can reference further footnotes, so iterate by index.
    for (let i = 0; i < this.footnoteOrder.length; i++) {
      const { label, id, inline } = this.footnoteOrder[i]!;
      let content: string;
      if (inline) {
        const marks = inline.getChildren('FootnoteMark');
        content = this.inline(inline, marks[0]!.to, marks[marks.length - 1]!.from);
      } else {
        const def = this.footnoteDefs.get(label);
        if (!def) continue;
        const marks = def.getChildren('FootnoteMark');
        content = this.paragraphContent(def, marks[marks.length - 1]!.to, def.to).trim();
      }
      items.push(
        `<li data-footnote-id="fn-${id}" id="fn-${id}" class="footnote-item"><p>${content}` +
          `<a href="#fnref-${id}" class="footnote-backref footnote-link" target="_self" rel="noopener nofollow">↩︎</a></p></li>\n`,
      );
    }
    if (!items.length) return '';
    return `<section class="footnotes"><hr class="footnotes-sep" />\n<ol class="footnotes-list">\n${items.join('')}</ol>\n</section>\n`;
  }
}

/** Parses and renders Markdown to an (unsanitised) HTML string. */
export function markdownToHtml(source: string, options: HtmlOptions = {}): string {
  return renderHtml(source, options).html;
}

export function renderHtml(source: string, options: HtmlOptions = {}): RenderedHtml {
  const parser = options.flavor === 'commonmark' ? commonmarkParser : obsidianParser;
  const tree = parser.parse(source);
  return { html: new Renderer(source, tree, options).render(), tree };
}
