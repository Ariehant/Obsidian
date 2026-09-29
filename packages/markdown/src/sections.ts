/**
 * Locating headings and blocks in a note: used for `[[Note#Heading]]` navigation and
 * `![[Note#^block]]` embeds. Uses the same OFM parse as rendering.
 */
import type { SyntaxNode } from '@lezer/common';
import { parseSubpath } from './links';
import { obsidianParser } from './syntax';

export interface HeadingInfo {
  level: number;
  /** Heading text as written, without `#` marks or a trailing block id. */
  text: string;
  from: number;
  to: number;
}

export interface SubpathRange {
  from: number;
  to: number;
}

const LEVELS: Record<string, number> = {
  ATXHeading1: 1,
  ATXHeading2: 2,
  ATXHeading3: 3,
  ATXHeading4: 4,
  ATXHeading5: 5,
  ATXHeading6: 6,
  SetextHeading1: 1,
  SetextHeading2: 2,
};

/** Characters that link text drops from heading names. */
export function normalizeHeading(text: string): string {
  return text
    .replace(/[#|^:[\]%]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function listHeadings(source: string): HeadingInfo[] {
  const tree = obsidianParser.parse(source);
  const out: HeadingInfo[] = [];
  for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
    const level = LEVELS[node.name];
    if (!level) continue;
    let from = node.from;
    let to = node.to;
    const marks = node.getChildren('HeaderMark');
    if (node.name.startsWith('ATX')) {
      if (marks[0]) from = marks[0].to;
      if (marks.length > 1) to = marks[marks.length - 1]!.from;
    } else if (marks.length) {
      to = marks[marks.length - 1]!.from;
    }
    const id = node.getChild('BlockId');
    if (id) to = Math.min(to, id.from);
    out.push({ level, text: source.slice(from, to).trim(), from: node.from, to: node.to });
  }
  return out;
}

function findBlock(source: string, id: string): SubpathRange | null {
  const tree = obsidianParser.parse(source);
  let found: SyntaxNode | null = null;
  tree.iterate({
    enter(n) {
      if (found) return false;
      if (n.name === 'BlockId' && source.slice(n.from + 1, n.to) === id) found = n.node;
      return undefined;
    },
  });
  if (!found) return null;
  let block: SyntaxNode | null = (found as SyntaxNode).parent;
  while (
    block &&
    !['Paragraph', 'ListItem', 'Task', 'ATXHeading1', 'Blockquote', 'Table'].includes(block.name)
  ) {
    if (/^(ATX|Setext)Heading/.test(block.name)) break;
    block = block.parent;
  }
  if (!block) return null;
  if (block.name === 'Task') block = block.parent ?? block;
  // A block id alone on its line after a list, table or quote refers to that block.
  if (block.name === 'Paragraph' && source.slice(block.from, block.to).trim() === `^${id}`) {
    const prev = block.prevSibling;
    if (prev) return { from: prev.from, to: prev.to };
  }
  const listItem = block.parent?.name === 'ListItem' ? block.parent : null;
  const target = listItem && block.name === 'Paragraph' ? listItem : block;
  return { from: target.from, to: target.to };
}

/**
 * Range of the section a subpath points at: a heading through the end of its section, or
 * the block holding a `^block-id`. Nested headings (`#A#B`) narrow step by step.
 */
export function resolveSubpath(source: string, subpath: string): SubpathRange | null {
  const { headings, block } = parseSubpath(subpath);
  if (block) return findBlock(source, block);
  if (!headings.length) return null;

  const all = listHeadings(source);
  let range: SubpathRange = { from: 0, to: source.length };
  let start = 0;
  for (const wanted of headings) {
    const key = normalizeHeading(wanted);
    const idx = all.findIndex(
      (h, i) => i >= start && h.from >= range.from && h.to <= range.to && normalizeHeading(h.text) === key,
    );
    if (idx === -1) return null;
    const h = all[idx]!;
    const next = all.find((n, i) => i > idx && n.level <= h.level);
    range = { from: h.from, to: Math.min(next ? next.from : source.length, range.to) };
    start = idx + 1;
  }
  return { from: range.from, to: source.slice(range.from, range.to).trimEnd().length + range.from };
}

/** 0-based line number of a document offset. */
export function lineAt(source: string, pos: number): number {
  let n = 0;
  for (let i = source.indexOf('\n'); i !== -1 && i < pos; i = source.indexOf('\n', i + 1)) n++;
  return n;
}
