/**
 * Lezer Markdown extensions for Obsidian-flavoured Markdown (OFM).
 *
 * One grammar feeds the editor (highlighting, Live Preview), the reading-view renderer and,
 * later, the metadata cache, so every consumer agrees on where a link, tag or block id is.
 *
 * Node names are part of this package's contract; renderers and editor decorations switch
 * on them.
 */
import type { Input } from '@lezer/common';
import { Tag, tags as t } from '@lezer/highlight';
import {
  GFM,
  parser as commonmarkParser,
  type BlockContext,
  type InlineContext,
  type LeafBlock,
  type LeafBlockParser,
  type Line,
  type MarkdownConfig,
} from '@lezer/markdown';

/** Highlight tags for OFM constructs, so editors can style them without knowing node names. */
export const ofmTags = {
  internalLink: Tag.define(t.link),
  embed: Tag.define(t.link),
  highlight: Tag.define(t.content),
  hashtag: Tag.define(t.labelName),
  math: Tag.define(t.string),
  blockId: Tag.define(t.meta),
  footnote: Tag.define(t.link),
  frontmatter: Tag.define(t.meta),
};

const enum Ch {
  Newline = 10,
  Space = 32,
  Tab = 9,
  Bang = 33,
  Hash = 35,
  Dollar = 36,
  Percent = 37,
  Equals = 61,
  OpenBracket = 91,
  Backslash = 92,
  CloseBracket = 93,
  Caret = 94,
  Pipe = 124,
}

const Punctuation = /[\p{S}\p{P}]/u;
const isSpace = (s: string) => /^\s?$/.test(s) || /\s/.test(s);

// ---------------------------------------------------------------------------------------
// Wikilinks and embeds: [[target#subpath|alias]] and ![[...]]

function parseWikilink(cx: InlineContext, start: number, contentStart: number, type: string): number {
  let close = -1;
  for (let i = contentStart; i < cx.end - 1; i++) {
    const c = cx.char(i);
    if (c === Ch.Newline) return -1;
    if (c === Ch.OpenBracket && cx.char(i + 1) === Ch.OpenBracket) return -1;
    if (c === Ch.CloseBracket && cx.char(i + 1) === Ch.CloseBracket) {
      close = i;
      break;
    }
  }
  if (close <= contentStart) return -1;

  let pipe = -1;
  for (let i = contentStart; i < close; i++) {
    if (cx.char(i) === Ch.Pipe) {
      pipe = i;
      break;
    }
  }
  // Inside tables the pipe is written as `\|`; the backslash isn't part of the target.
  const targetEnd = pipe === -1 ? close : cx.char(pipe - 1) === Ch.Backslash ? pipe - 1 : pipe;

  const children = [cx.elt('InternalLinkMark', start, contentStart)];
  if (targetEnd > contentStart) children.push(cx.elt('InternalLinkPath', contentStart, targetEnd));
  if (pipe !== -1) {
    children.push(cx.elt('InternalLinkPipe', targetEnd, pipe + 1));
    if (close > pipe + 1) children.push(cx.elt('InternalLinkAlias', pipe + 1, close));
  }
  children.push(cx.elt('InternalLinkMark', close, close + 2));
  return cx.addElement(cx.elt(type, start, close + 2, children));
}

export const Wikilinks: MarkdownConfig = {
  defineNodes: [
    { name: 'InternalLink', style: ofmTags.internalLink },
    { name: 'Embed', style: ofmTags.embed },
    { name: 'InternalLinkMark', style: t.processingInstruction },
    { name: 'InternalLinkPath', style: ofmTags.internalLink },
    { name: 'InternalLinkPipe', style: t.processingInstruction },
    { name: 'InternalLinkAlias', style: ofmTags.internalLink },
  ],
  parseInline: [
    {
      name: 'Embed',
      parse(cx, next, pos) {
        if (next !== Ch.Bang || cx.char(pos + 1) !== Ch.OpenBracket || cx.char(pos + 2) !== Ch.OpenBracket) {
          return -1;
        }
        return parseWikilink(cx, pos, pos + 3, 'Embed');
      },
      before: 'Image',
    },
    {
      name: 'InternalLink',
      parse(cx, next, pos) {
        if (next !== Ch.OpenBracket || cx.char(pos + 1) !== Ch.OpenBracket) return -1;
        return parseWikilink(cx, pos, pos + 2, 'InternalLink');
      },
      before: 'Link',
    },
  ],
};

// ---------------------------------------------------------------------------------------
// ==Highlight==

const HighlightDelim = { resolve: 'Highlight', mark: 'HighlightMark' };

export const Highlight: MarkdownConfig = {
  defineNodes: [
    { name: 'Highlight', style: { 'Highlight/...': ofmTags.highlight } },
    { name: 'HighlightMark', style: t.processingInstruction },
  ],
  parseInline: [
    {
      name: 'Highlight',
      parse(cx, next, pos) {
        if (next !== Ch.Equals || cx.char(pos + 1) !== Ch.Equals || cx.char(pos + 2) === Ch.Equals) return -1;
        const before = cx.slice(pos - 1, pos);
        const after = cx.slice(pos + 2, pos + 3);
        const sBefore = isSpace(before);
        const sAfter = isSpace(after);
        const pBefore = Punctuation.test(before);
        const pAfter = Punctuation.test(after);
        return cx.addDelimiter(
          HighlightDelim,
          pos,
          pos + 2,
          !sAfter && (!pAfter || sBefore || pBefore),
          !sBefore && (!pBefore || sAfter || pAfter),
        );
      },
      after: 'Emphasis',
    },
  ],
};

// ---------------------------------------------------------------------------------------
// %%Comments%% (inline and block). An unterminated block comment runs to the end.

export const Comments: MarkdownConfig = {
  defineNodes: [
    { name: 'ObsidianComment', style: t.comment },
    { name: 'ObsidianCommentBlock', block: true, style: t.comment },
    { name: 'ObsidianCommentMark', style: t.comment },
  ],
  parseInline: [
    {
      name: 'ObsidianComment',
      parse(cx, next, pos) {
        if (next !== Ch.Percent || cx.char(pos + 1) !== Ch.Percent) return -1;
        const text = cx.slice(pos + 2, cx.end);
        const idx = text.indexOf('%%');
        if (idx === -1) return -1;
        const end = pos + 2 + idx + 2;
        return cx.addElement(
          cx.elt('ObsidianComment', pos, end, [
            cx.elt('ObsidianCommentMark', pos, pos + 2),
            cx.elt('ObsidianCommentMark', end - 2, end),
          ]),
        );
      },
      before: 'Emphasis',
    },
  ],
  parseBlock: [
    {
      name: 'ObsidianCommentBlock',
      parse(cx, line) {
        return parseFencedBlock(cx, line, '%%', 'ObsidianCommentBlock', 'ObsidianCommentMark');
      },
      before: 'FencedCode',
    },
  ],
};

/**
 * Block delimited by `fence` on its first line and the next line containing `fence`
 * (e.g. `%%` comments, `$$` math). Returns false when the line doesn't start one.
 */
function parseFencedBlock(
  cx: BlockContext,
  line: Line,
  fence: string,
  type: string,
  markType: string,
): boolean {
  if (line.indent - line.baseIndent >= 4 || !line.text.startsWith(fence, line.pos)) return false;
  const from = cx.lineStart + line.pos;
  const rest = line.text.slice(line.pos + fence.length);
  const sameLine = rest.indexOf(fence);

  if (sameLine !== -1) {
    // One-line form (`$$x$$`, `%%x%%`): only a block if nothing follows the closing fence.
    if (rest.slice(sameLine + fence.length).trim()) return false;
    const end = from + fence.length + sameLine + fence.length;
    const marks = [cx.elt(markType, from, from + fence.length), cx.elt(markType, end - fence.length, end)];
    cx.nextLine();
    cx.addElement(cx.elt(type, from, end, marks));
    return true;
  }

  const marks = [cx.elt(markType, from, from + fence.length)];
  let end = cx.lineStart + line.text.length;
  while (cx.nextLine()) {
    marks.push(...line.markers);
    const idx = line.text.indexOf(fence, line.basePos);
    if (idx !== -1) {
      const s = cx.lineStart + idx;
      marks.push(cx.elt(markType, s, s + fence.length));
      end = s + fence.length;
      cx.nextLine();
      break;
    }
    end = cx.lineStart + line.text.length;
  }
  cx.addElement(cx.elt(type, from, end, marks));
  return true;
}

// ---------------------------------------------------------------------------------------
// #tags

// Letters, marks, numbers, `_`, `-`, `/` and emoji. A tag can't be only digits.
const TagBody = /^(?:[\p{L}\p{M}\p{N}_\-/]|\p{Extended_Pictographic}|‍|️)+/u;

export const Tags: MarkdownConfig = {
  defineNodes: [
    { name: 'Hashtag', style: ofmTags.hashtag },
    { name: 'HashtagMark', style: ofmTags.hashtag },
    { name: 'HashtagLabel', style: ofmTags.hashtag },
  ],
  parseInline: [
    {
      name: 'Hashtag',
      parse(cx, next, pos) {
        if (next !== Ch.Hash) return -1;
        if (pos > cx.offset && !/\s/.test(cx.slice(pos - 1, pos))) return -1;
        const m = TagBody.exec(cx.slice(pos + 1, cx.end));
        if (!m || /^[\d/]+$/.test(m[0])) return -1;
        const end = pos + 1 + m[0].length;
        return cx.addElement(
          cx.elt('Hashtag', pos, end, [
            cx.elt('HashtagMark', pos, pos + 1),
            cx.elt('HashtagLabel', pos + 1, end),
          ]),
        );
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------
// ^block-ids at the end of a block

export const BlockIds: MarkdownConfig = {
  defineNodes: [{ name: 'BlockId', style: ofmTags.blockId }],
  parseInline: [
    {
      name: 'BlockId',
      parse(cx, next, pos) {
        if (next !== Ch.Caret || cx.char(pos + 1) === Ch.OpenBracket) return -1;
        if (pos > cx.offset && !/\s/.test(cx.slice(pos - 1, pos))) return -1;
        const m = /^\^([A-Za-z0-9-]+)[ \t]*$/.exec(cx.slice(pos, cx.end));
        if (!m) return -1;
        return cx.addElement(cx.elt('BlockId', pos, pos + 1 + m[1]!.length));
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------
// $inline$ / $$display$$ math and $$ math blocks

export const MathSyntax: MarkdownConfig = {
  defineNodes: [
    { name: 'InlineMath', style: ofmTags.math },
    { name: 'MathBlock', block: true, style: ofmTags.math },
    { name: 'MathMark', style: t.processingInstruction },
  ],
  parseInline: [
    {
      name: 'InlineMath',
      parse(cx, next, pos) {
        if (next !== Ch.Dollar) return -1;
        if (cx.char(pos + 1) === Ch.Dollar) {
          const idx = cx.slice(pos + 2, cx.end).indexOf('$$');
          if (idx <= 0) return -1;
          const end = pos + 2 + idx + 2;
          return cx.addElement(
            cx.elt('InlineMath', pos, end, [
              cx.elt('MathMark', pos, pos + 2),
              cx.elt('MathMark', end - 2, end),
            ]),
          );
        }
        const first = cx.char(pos + 1);
        if (first === Ch.Space || first === Ch.Tab || first === Ch.Newline || first === -1) return -1;
        for (let i = pos + 1; i < cx.end; i++) {
          const c = cx.char(i);
          if (c === Ch.Backslash) {
            i++;
            continue;
          }
          if (c !== Ch.Dollar) continue;
          const prev = cx.char(i - 1);
          const after = cx.char(i + 1);
          if (prev === Ch.Space || prev === Ch.Tab || prev === Ch.Newline || (after >= 48 && after <= 57))
            return -1;
          return cx.addElement(
            cx.elt('InlineMath', pos, i + 1, [
              cx.elt('MathMark', pos, pos + 1),
              cx.elt('MathMark', i, i + 1),
            ]),
          );
        }
        return -1;
      },
      before: 'Escape',
    },
  ],
  parseBlock: [
    {
      name: 'MathBlock',
      parse(cx, line) {
        return parseFencedBlock(cx, line, '$$', 'MathBlock', 'MathMark');
      },
      before: 'FencedCode',
    },
  ],
};

// ---------------------------------------------------------------------------------------
// Footnotes: [^ref], ^[inline], and [^ref]: definitions

export const Footnotes: MarkdownConfig = {
  defineNodes: [
    { name: 'FootnoteReference', style: ofmTags.footnote },
    { name: 'InlineFootnote', style: ofmTags.footnote },
    { name: 'FootnoteDefinition', block: true },
    { name: 'FootnoteMark', style: t.processingInstruction },
    { name: 'FootnoteLabel', style: ofmTags.footnote },
  ],
  parseInline: [
    {
      name: 'FootnoteReference',
      parse(cx, next, pos) {
        if (next !== Ch.OpenBracket || cx.char(pos + 1) !== Ch.Caret) return -1;
        const m = /^\[\^([^\]\s]+)\]/.exec(cx.slice(pos, cx.end));
        if (!m) return -1;
        const end = pos + m[0].length;
        return cx.addElement(
          cx.elt('FootnoteReference', pos, end, [
            cx.elt('FootnoteMark', pos, pos + 2),
            cx.elt('FootnoteLabel', pos + 2, end - 1),
            cx.elt('FootnoteMark', end - 1, end),
          ]),
        );
      },
      before: 'Link',
    },
    {
      name: 'InlineFootnote',
      parse(cx, next, pos) {
        if (next !== Ch.Caret || cx.char(pos + 1) !== Ch.OpenBracket) return -1;
        let depth = 0;
        for (let i = pos + 1; i < cx.end; i++) {
          const c = cx.char(i);
          if (c === Ch.Backslash) i++;
          else if (c === Ch.OpenBracket) depth++;
          else if (c === Ch.CloseBracket && --depth === 0) {
            if (i === pos + 2) return -1;
            const inner = cx.parser.parseInline(cx.slice(pos + 2, i), pos + 2);
            return cx.addElement(
              cx.elt('InlineFootnote', pos, i + 1, [
                cx.elt('FootnoteMark', pos, pos + 2),
                ...inner,
                cx.elt('FootnoteMark', i, i + 1),
              ]),
            );
          }
        }
        return -1;
      },
      before: 'Link',
    },
  ],
  parseBlock: [
    {
      name: 'FootnoteDefinition',
      parse(cx, line) {
        if (line.indent - line.baseIndent >= 4) return false;
        const m = /^\[\^([^\]\s]+)\]:[ \t]?/.exec(line.text.slice(line.pos));
        if (!m) return false;
        const from = cx.lineStart + line.pos;
        const contentFrom = from + m[0].length;
        let content = line.text.slice(line.pos + m[0].length);
        let end = cx.lineStart + line.text.length;
        const children = [
          cx.elt('FootnoteMark', from, from + 2),
          cx.elt('FootnoteLabel', from + 2, from + 2 + m[1]!.length),
          cx.elt('FootnoteMark', from + 2 + m[1]!.length, from + 4 + m[1]!.length),
        ];
        const BlockStart = /^\s{0,3}(?:\[\^|#{1,6}\s|>|[-*+]\s|\d+[.)]\s|```|~~~|\$\$)/;
        while (cx.nextLine()) {
          const rest = line.text.slice(line.basePos);
          if (!rest.trim() || BlockStart.test(rest)) break;
          // Keep the line's leading whitespace so content offsets stay aligned with the document.
          content += '\n' + line.text.slice(line.basePos);
          end = cx.lineStart + line.text.length;
        }
        children.push(...cx.parser.parseInline(content, contentFrom).filter((e) => e.to <= end));
        cx.addElement(cx.elt('FootnoteDefinition', from, end, children));
        return true;
      },
      before: 'LinkReference',
    },
  ],
};

// ---------------------------------------------------------------------------------------
// YAML frontmatter: `---` on the first line, closed by `---` on its own line.

const FrontmatterRe = /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/;

export const Frontmatter: MarkdownConfig = {
  defineNodes: [
    { name: 'Frontmatter', block: true, style: ofmTags.frontmatter },
    { name: 'FrontmatterMark', style: t.processingInstruction },
    { name: 'FrontmatterContent', style: ofmTags.frontmatter },
  ],
  parseBlock: [
    {
      name: 'Frontmatter',
      parse(cx, line) {
        if (cx.lineStart !== 0 || cx.parentType().name !== 'Document' || !/^---[ \t]*$/.test(line.text))
          return false;
        // Frontmatter needs a closing fence; peek at the document, which `BlockContext`
        // doesn't expose publicly but always carries.
        const input = (cx as unknown as { input: Input }).input;
        const head = input.read(0, Math.min(input.length, 1 << 20));
        const m = FrontmatterRe.exec(head);
        if (!m) return false;
        const block = m[0].replace(/\r?\n$/, '');
        const end = block.length;
        const closeFrom = block.lastIndexOf('---');
        const contentFrom = line.text.length + 1;
        const children = [cx.elt('FrontmatterMark', 0, 3)];
        if (closeFrom - 1 > contentFrom)
          children.push(cx.elt('FrontmatterContent', contentFrom, closeFrom - 1));
        children.push(cx.elt('FrontmatterMark', closeFrom, closeFrom + 3));
        while (cx.lineStart < closeFrom && cx.nextLine()) {
          /* consume up to the closing fence */
        }
        cx.nextLine();
        cx.addElement(cx.elt('Frontmatter', 0, end, children));
        return true;
      },
      before: 'HorizontalRule',
    },
  ],
};

// ---------------------------------------------------------------------------------------
// Task lists with any single-character status: [ ] [x] [/] [?] [-] …

class TaskParser implements LeafBlockParser {
  nextLine(): boolean {
    return false;
  }

  finish(cx: BlockContext, leaf: LeafBlock): boolean {
    cx.addLeafElement(
      leaf,
      cx.elt('Task', leaf.start, leaf.start + leaf.content.length, [
        cx.elt('TaskMarker', leaf.start, leaf.start + 3),
        ...cx.parser.parseInline(leaf.content.slice(3), leaf.start + 3),
      ]),
    );
    return true;
  }
}

export const Tasks: MarkdownConfig = {
  remove: ['TaskList'],
  parseBlock: [
    {
      name: 'ObsidianTaskList',
      leaf(cx, leaf) {
        return /^\[[^\]\n\r]\](?:[ \t]|$)/.test(leaf.content) && cx.parentType().name === 'ListItem'
          ? new TaskParser()
          : null;
      },
      after: 'SetextHeading',
    },
  ],
};

/** GFM plus every OFM extension, in the order they need to run. */
export const obsidianExtensions = [
  GFM,
  Tasks,
  Frontmatter,
  Wikilinks,
  Highlight,
  Comments,
  Tags,
  BlockIds,
  MathSyntax,
  Footnotes,
];

export const obsidianParser = commonmarkParser.configure(obsidianExtensions);
export { commonmarkParser };
