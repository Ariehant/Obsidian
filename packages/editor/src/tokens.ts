/**
 * Token and line classes for the Markdown editor, applied in both source mode and Live
 * Preview. The class vocabulary (`cm-header-1`, `cm-formatting-strong`, `HyperMD-quote`,
 * …) is what community themes and CSS snippets target, so treat it as an API.
 */
import { syntaxTree } from '@codemirror/language';
import type { Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import type { SyntaxNodeRef } from '@lezer/common';

const HEADING = /^(?:ATX|Setext)Heading(\d)$/;

function depthOf(node: SyntaxNodeRef, name: string): number {
  let d = 0;
  for (let p = node.node.parent; p; p = p.parent) if (p.name === name) d++;
  return d;
}

function listDepth(node: SyntaxNodeRef): number {
  let d = 0;
  for (let p = node.node.parent; p; p = p.parent)
    if (p.name === 'BulletList' || p.name === 'OrderedList') d++;
  return Math.max(d, 1);
}

const mark = (cls: string) => Decoration.mark({ class: cls });
const markCache = new Map<string, Decoration>();
const cachedMark = (cls: string) => {
  let d = markCache.get(cls);
  if (!d) markCache.set(cls, (d = mark(cls)));
  return d;
};

/** Class for a node's own range, or null when the node gets no mark. */
function nodeClass(node: SyntaxNodeRef, parentName: string | undefined): string | null {
  const h = HEADING.exec(node.name);
  if (h) return `cm-header cm-header-${h[1]}`;
  switch (node.name) {
    case 'HeaderMark': {
      const ph = parentName ? HEADING.exec(parentName) : null;
      return ph
        ? `cm-formatting cm-formatting-header cm-formatting-header-${ph[1]} cm-header cm-header-${ph[1]}`
        : 'cm-formatting';
    }
    case 'Emphasis':
      return 'cm-em';
    case 'StrongEmphasis':
      return 'cm-strong';
    case 'Strikethrough':
      return 'cm-strikethrough';
    case 'Highlight':
      return 'cm-highlight';
    case 'EmphasisMark':
      return parentName === 'StrongEmphasis'
        ? 'cm-formatting cm-formatting-strong'
        : 'cm-formatting cm-formatting-em';
    case 'StrikethroughMark':
      return 'cm-formatting cm-formatting-strikethrough';
    case 'HighlightMark':
      return 'cm-formatting cm-formatting-highlight';
    case 'InlineCode':
      return 'cm-inline-code';
    case 'CodeMark':
      return parentName === 'InlineCode'
        ? 'cm-formatting cm-formatting-code'
        : 'cm-formatting cm-formatting-code-block cm-hmd-codeblock';
    case 'CodeInfo':
      return 'cm-formatting cm-formatting-code-block cm-hmd-codeblock';
    case 'CodeText':
      return 'cm-hmd-codeblock';
    case 'Link':
      return 'cm-link';
    case 'Image':
      return 'cm-image';
    case 'LinkMark':
      return parentName === 'Image'
        ? 'cm-formatting cm-formatting-image cm-image-marker'
        : 'cm-formatting cm-formatting-link';
    case 'URL':
      return parentName === 'Link' || parentName === 'Image' ? 'cm-string cm-url' : 'cm-url';
    case 'LinkTitle':
      return 'cm-string cm-link-title';
    case 'LinkLabel':
      return 'cm-link-label';
    case 'Autolink':
      return 'cm-url';
    case 'InternalLink':
    case 'Embed':
      return null;
    case 'InternalLinkMark': {
      const embed = parentName === 'Embed' ? ' cm-formatting-embed' : '';
      const isStart = node.from === node.node.parent?.from;
      return `cm-formatting-link cm-formatting-link-${isStart ? 'start' : 'end'}${embed}`;
    }
    case 'InternalLinkPath':
      return node.node.nextSibling?.name === 'InternalLinkPipe'
        ? 'cm-hmd-internal-link cm-link-has-alias'
        : 'cm-hmd-internal-link';
    case 'InternalLinkPipe':
      return 'cm-hmd-internal-link cm-link-alias-pipe';
    case 'InternalLinkAlias':
      return 'cm-hmd-internal-link cm-link-alias';
    case 'HashtagMark':
      return 'cm-formatting cm-formatting-hashtag cm-hashtag cm-hashtag-begin cm-meta';
    case 'HashtagLabel':
      return 'cm-hashtag cm-hashtag-end cm-meta';
    case 'BlockId':
      return 'cm-blockid';
    case 'ObsidianComment':
    case 'ObsidianCommentBlock':
      return 'cm-comment';
    case 'InlineMath':
    case 'MathBlock':
      return 'cm-math';
    case 'MathMark':
      return 'cm-formatting cm-formatting-math';
    case 'FootnoteReference':
      return 'cm-footref cm-hmd-barelink';
    case 'InlineFootnote':
      return 'cm-inline-footnote';
    case 'FootnoteMark':
    case 'FootnoteLabel':
      return 'cm-footref';
    case 'FrontmatterContent':
      return 'cm-hmd-frontmatter';
    case 'FrontmatterMark':
      return 'cm-def cm-hmd-frontmatter';
    case 'HorizontalRule':
      return 'cm-hr';
    case 'TableDelimiter':
      return 'cm-hmd-table-sep';
    case 'Escape':
      return 'cm-formatting cm-formatting-escape cm-escape';
    case 'TaskMarker':
      return 'cm-formatting cm-formatting-task';
    case 'QuoteMark': {
      const d = Math.max(depthOf(node, 'Blockquote'), 1);
      return `cm-formatting cm-formatting-quote cm-formatting-quote-${d} cm-quote cm-quote-${d}`;
    }
    case 'ListMark': {
      const d = listDepth(node);
      const kind = node.node.parent?.parent?.name === 'OrderedList' ? 'ol' : 'ul';
      return `cm-formatting cm-formatting-list cm-formatting-list-${kind} cm-list-${d}`;
    }
    default:
      return null;
  }
}

function lineClasses(
  view: EditorView,
  node: SyntaxNodeRef,
  add: (line: number, cls: string, attrs?: Record<string, string>) => void,
) {
  const doc = view.state.doc;
  const lines = () => {
    const first = doc.lineAt(node.from).number;
    const last = doc.lineAt(
      Math.max(
        node.from,
        node.to - (node.to > node.from && doc.sliceString(node.to - 1, node.to) === '\n' ? 1 : 0),
      ),
    ).number;
    return { first, last };
  };
  const h = HEADING.exec(node.name);
  if (h) {
    const { first, last } = lines();
    for (let l = first; l <= last; l++) add(l, `HyperMD-header HyperMD-header-${h[1]}`);
    return;
  }
  switch (node.name) {
    case 'Blockquote': {
      const d = depthOf(node, 'Blockquote') + 1;
      const { first, last } = lines();
      for (let l = first; l <= last; l++) add(l, `HyperMD-quote HyperMD-quote-${d}`);
      return;
    }
    case 'ListItem': {
      const d = listDepth(node);
      const { first, last } = lines();
      add(first, `HyperMD-list-line HyperMD-list-line-${d}`);
      for (let l = first + 1; l <= last; l++) add(l, `HyperMD-list-line HyperMD-list-line-nobullet`);
      return;
    }
    case 'Task': {
      const { first } = lines();
      const status = doc.sliceString(node.from + 1, node.from + 2);
      add(first, 'HyperMD-task-line', { 'data-task': status });
      return;
    }
    case 'FencedCode':
    case 'CodeBlock': {
      const { first, last } = lines();
      for (let l = first; l <= last; l++) {
        let cls = 'HyperMD-codeblock HyperMD-codeblock-bg';
        if (node.name === 'FencedCode' && l === first)
          cls += ' HyperMD-codeblock-begin HyperMD-codeblock-begin-bg';
        if (node.name === 'FencedCode' && l === last && last > first)
          cls += ' HyperMD-codeblock-end HyperMD-codeblock-end-bg';
        add(l, cls);
      }
      return;
    }
    case 'Frontmatter': {
      const { first, last } = lines();
      for (let l = first; l <= last; l++) {
        add(
          l,
          `HyperMD-frontmatter${l === first ? ' HyperMD-frontmatter-begin' : l === last ? ' HyperMD-frontmatter-end' : ''}`,
        );
      }
      return;
    }
    case 'HorizontalRule':
      add(lines().first, 'HyperMD-hr');
      return;
    case 'Table': {
      const { first, last } = lines();
      for (let l = first; l <= last; l++) add(l, `HyperMD-table-row HyperMD-table-row-${l - first}`);
      return;
    }
    case 'MathBlock':
    case 'ObsidianCommentBlock': {
      const { first, last } = lines();
      for (let l = first; l <= last; l++)
        add(l, node.name === 'MathBlock' ? 'HyperMD-math' : 'HyperMD-comment');
      return;
    }
    case 'FootnoteDefinition':
      add(lines().first, 'HyperMD-footnote');
      return;
  }
}

function buildTokens(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const lineAttrs = new Map<number, { cls: string[]; attrs: Record<string, string> }>();
  const addLine = (line: number, cls: string, attrs?: Record<string, string>) => {
    const entry = lineAttrs.get(line) ?? { cls: [], attrs: {} };
    entry.cls.push(cls);
    Object.assign(entry.attrs, attrs);
    lineAttrs.set(line, entry);
  };
  const tree = syntaxTree(view.state);
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        lineClasses(view, node, addLine);
        const cls = nodeClass(node, node.node.parent?.name);
        if (cls && node.to > node.from) ranges.push(cachedMark(cls).range(node.from, node.to));
      },
    });
  }
  for (const [line, { cls, attrs }] of lineAttrs) {
    const pos = view.state.doc.line(line).from;
    ranges.push(
      Decoration.line({ class: [...new Set(cls.join(' ').split(' '))].join(' '), attributes: attrs }).range(
        pos,
      ),
    );
  }
  return Decoration.set(ranges, true);
}

/** Adds Obsidian-compatible token and line classes to visible Markdown. */
export const markdownTokens = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildTokens(view);
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.decorations = buildTokens(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);
