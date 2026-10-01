/**
 * `CachedMetadata` from Markdown source, using the same OFM grammar as the editor and
 * renderer. Pure and DOM-free so it can run in a worker; import it directly
 * (`@basalt/markdown/src/metadata`) to keep worker bundles small.
 */
import type {
  BlockCache,
  CachedMetadata,
  FootnoteCache,
  FootnoteRefCache,
  FrontmatterLinkCache,
  HeadingCache,
  ListItemCache,
  Loc,
  Pos,
  ReferenceCache,
  SectionCache,
  TagCache,
} from '@basalt/core/src/metadata-types';
import { parseYaml } from '@basalt/core/src/frontmatter';
import type { SyntaxNode } from '@lezer/common';
import { parseCalloutHeader } from './callouts';
import { isExternalUrl } from './links';
import { obsidianParser } from './syntax';

const HEADING = /^(?:ATX|Setext)Heading(\d)$/;

const SECTION_TYPES: Record<string, string> = {
  Paragraph: 'paragraph',
  BulletList: 'list',
  OrderedList: 'list',
  FencedCode: 'code',
  CodeBlock: 'code',
  Blockquote: 'blockquote',
  Table: 'table',
  HorizontalRule: 'thematicBreak',
  HTMLBlock: 'html',
  CommentBlock: 'html',
  ProcessingInstructionBlock: 'html',
  Frontmatter: 'yaml',
  MathBlock: 'math',
  FootnoteDefinition: 'footnoteDefinition',
  ObsidianCommentBlock: 'comment',
  LinkReference: 'definition',
};

class Positions {
  private readonly lineStarts: number[] = [0];

  constructor(source: string) {
    for (let i = source.indexOf('\n'); i !== -1; i = source.indexOf('\n', i + 1)) this.lineStarts.push(i + 1);
  }

  loc(offset: number): Loc {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo, col: offset - this.lineStarts[lo]!, offset };
  }

  pos(from: number, to: number): Pos {
    return { start: this.loc(from), end: this.loc(to) };
  }
}

const WIKILINK_IN_TEXT = /\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]/g;

export function computeMetadata(source: string): CachedMetadata {
  const tree = obsidianParser.parse(source);
  const P = new Positions(source);
  const slice = (n: { from: number; to: number }) => source.slice(n.from, n.to);

  const headings: HeadingCache[] = [];
  const links: ReferenceCache[] = [];
  const embeds: ReferenceCache[] = [];
  const tags: TagCache[] = [];
  const sections: SectionCache[] = [];
  const listItems: ListItemCache[] = [];
  const footnotes: FootnoteCache[] = [];
  const footnoteRefs: FootnoteRefCache[] = [];
  const blocks: Record<string, BlockCache> = {};
  const meta: CachedMetadata = {};

  // --- Sections (top-level blocks) ---------------------------------------------------
  for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
    const level = HEADING.exec(node.name);
    let type = level ? 'heading' : SECTION_TYPES[node.name];
    if (!type) continue;
    if (type === 'blockquote') {
      const firstLineEnd = source.indexOf('\n', node.from);
      const firstLine = source.slice(
        node.from,
        firstLineEnd === -1 ? node.to : Math.min(firstLineEnd, node.to),
      );
      if (parseCalloutHeader(firstLine.replace(/^\s*>\s?/, ''))) type = 'callout';
    }
    sections.push({ type, position: P.pos(node.from, node.to) });
  }

  // --- Frontmatter ---------------------------------------------------------------------
  const fm = tree.topNode.firstChild?.name === 'Frontmatter' ? tree.topNode.firstChild : null;
  if (fm) {
    meta.frontmatterPosition = P.pos(fm.from, fm.to);
    const content = fm.getChild('FrontmatterContent');
    try {
      const value = content ? parseYaml(slice(content)) : null;
      meta.frontmatter = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch {
      // Invalid YAML: the block is still frontmatter, but has no properties.
    }
    if (meta.frontmatter) {
      const fmLinks = frontmatterLinks(meta.frontmatter);
      if (fmLinks.length) meta.frontmatterLinks = fmLinks;
    }
  }

  // --- Walk ----------------------------------------------------------------------------
  const blockFor = (id: SyntaxNode): SyntaxNode | null => {
    let block: SyntaxNode | null = id.parent;
    while (
      block &&
      !/^(Paragraph|ListItem|Task|Blockquote|Table|FootnoteDefinition)$/.test(block.name) &&
      !HEADING.test(block.name)
    ) {
      block = block.parent;
    }
    if (!block) return null;
    if (block.name === 'Task' || (block.name === 'Paragraph' && block.parent?.name === 'ListItem')) {
      block = block.parent ?? block;
    }
    if (block.name === 'Paragraph' && slice(block).trim() === slice(id)) return block.prevSibling ?? block;
    return block;
  };

  const listParents: Array<{ node: SyntaxNode; line: number }> = [];
  tree.iterate({
    enter: (ref) => {
      const node = ref.node;
      const level = HEADING.exec(node.name);
      if (level) {
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
        headings.push({
          heading: source.slice(from, to).trim(),
          level: Number(level[1]),
          position: P.pos(node.from, node.to),
        });
        return;
      }
      switch (node.name) {
        case 'InternalLink':
        case 'Embed': {
          const path = node.getChild('InternalLinkPath');
          const alias = node.getChild('InternalLinkAlias');
          const link = path ? slice(path).trim() : '';
          if (!link) return false;
          const entry: ReferenceCache = { link, original: slice(node), position: P.pos(node.from, node.to) };
          entry.displayText = alias ? slice(alias).trim() : link;
          (node.name === 'Embed' ? embeds : links).push(entry);
          return false;
        }
        case 'Link':
        case 'Image': {
          const url = node.getChild('URL');
          if (!url) return;
          const raw = slice(url).replace(/^<|>$/g, '');
          if (!raw || isExternalUrl(raw)) return;
          let link = raw;
          try {
            link = decodeURI(raw);
          } catch {
            /* keep as written */
          }
          const marks = node.getChildren('LinkMark');
          const open = marks[0];
          const close = marks.find((m) => slice(m) === ']');
          const display = open && close ? source.slice(open.to, close.from) : '';
          const entry: ReferenceCache = {
            link,
            original: slice(node),
            displayText: display,
            position: P.pos(node.from, node.to),
          };
          (node.name === 'Image' ? embeds : links).push(entry);
          return;
        }
        case 'Hashtag':
          tags.push({ tag: slice(node), position: P.pos(node.from, node.to) });
          return false;
        case 'BlockId': {
          const id = slice(node).slice(1);
          const block = blockFor(node);
          if (block && !blocks[id.toLowerCase()]) {
            blocks[id.toLowerCase()] = { id, position: P.pos(block.from, block.to) };
          }
          return false;
        }
        case 'FootnoteReference': {
          const label = node.getChild('FootnoteLabel');
          if (label) footnoteRefs.push({ id: slice(label), position: P.pos(node.from, node.to) });
          return false;
        }
        case 'FootnoteDefinition': {
          const label = node.getChild('FootnoteLabel');
          if (label) footnotes.push({ id: slice(label), position: P.pos(node.from, node.to) });
          return;
        }
        case 'ListItem': {
          const line = P.loc(node.from).line;
          while (listParents.length && listParents[listParents.length - 1]!.node.to < node.from)
            listParents.pop();
          const parentItem = listParents[listParents.length - 1];
          let parent: number;
          if (parentItem && node.from >= parentItem.node.from && node.to <= parentItem.node.to)
            parent = parentItem.line;
          else {
            const list = node.parent;
            const first = list?.firstChild;
            parent = -(first ? P.loc(first.from).line : line);
          }
          const task = node.getChild('Task');
          const item: ListItemCache = { parent, position: P.pos(node.from, node.to) };
          if (task) item.task = source[task.from + 1];
          const content = task ?? node.getChild('Paragraph');
          const id = content?.getChild('BlockId');
          if (id) item.id = slice(id).slice(1);
          listItems.push(item);
          listParents.push({ node, line });
          return;
        }
        case 'Frontmatter':
        case 'FencedCode':
        case 'CodeBlock':
        case 'InlineCode':
        case 'ObsidianComment':
        case 'ObsidianCommentBlock':
        case 'InlineMath':
        case 'MathBlock':
        case 'HTMLBlock':
          return false;
        default:
          return;
      }
    },
  });

  // Section ids come from the block ids they contain.
  for (const b of Object.values(blocks)) {
    const s = sections.find(
      (sec) =>
        sec.position.start.offset <= b.position.start.offset &&
        sec.position.end.offset >= b.position.end.offset,
    );
    if (s && !s.id && s.type !== 'list') s.id = b.id;
  }

  if (headings.length) meta.headings = headings;
  if (links.length) meta.links = links;
  if (embeds.length) meta.embeds = embeds;
  if (tags.length) meta.tags = tags;
  if (sections.length) meta.sections = sections;
  if (listItems.length) meta.listItems = listItems;
  if (footnotes.length) meta.footnotes = footnotes;
  if (footnoteRefs.length) meta.footnoteRefs = footnoteRefs;
  if (Object.keys(blocks).length) meta.blocks = blocks;
  return meta;
}

/** `[[links]]` inside frontmatter string values (including list items). */
function frontmatterLinks(frontmatter: Record<string, any>): FrontmatterLinkCache[] {
  const out: FrontmatterLinkCache[] = [];
  const visit = (key: string, value: unknown) => {
    if (typeof value === 'string') {
      for (const m of value.matchAll(WIKILINK_IN_TEXT)) {
        const link = m[1]!.trim();
        out.push({ key, link, original: m[0], displayText: (m[2] ?? link).trim() });
      }
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => visit(`${key}.${i}`, v));
    }
  };
  for (const [key, value] of Object.entries(frontmatter)) visit(key, value);
  return out;
}
