/** Metadata shapes, identical to the plugin API's `CachedMetadata` family. */

export interface Loc {
  /** 0-based line. */
  line: number;
  /** 0-based column. */
  col: number;
  /** Offset from the start of the document. */
  offset: number;
}

export interface Pos {
  start: Loc;
  end: Loc;
}

export interface CacheItem {
  position: Pos;
}

export interface HeadingCache extends CacheItem {
  heading: string;
  level: number;
}

export interface Reference {
  /** Link target as written, e.g. `Note#Heading` (Markdown links are URL-decoded). */
  link: string;
  /** The exact source text, e.g. `[[Note#Heading|alias]]`. */
  original: string;
  displayText?: string;
}

export interface ReferenceCache extends Reference, CacheItem {}
export type LinkCache = ReferenceCache;
export type EmbedCache = ReferenceCache;

export interface TagCache extends CacheItem {
  /** Including the leading `#`. */
  tag: string;
}

export interface BlockCache extends CacheItem {
  id: string;
}

export interface SectionCache extends CacheItem {
  id?: string | undefined;
  type: string;
}

export interface ListItemCache extends CacheItem {
  id?: string | undefined;
  /** Status character for tasks (`' '`, `'x'`, …); undefined for plain items. */
  task?: string | undefined;
  /**
   * Line of the parent item. For top-level items: the negated line of the list's first item.
   */
  parent: number;
}

export interface FrontMatterCache {
  [key: string]: any;
}

export interface FootnoteCache extends CacheItem {
  id: string;
}

export interface FootnoteRefCache extends CacheItem {
  id: string;
}

export interface FrontmatterLinkCache extends Reference {
  key: string;
}

export interface ReferenceLinkCache extends CacheItem {
  id: string;
  link: string;
}

export interface CachedMetadata {
  links?: LinkCache[];
  embeds?: EmbedCache[];
  tags?: TagCache[];
  headings?: HeadingCache[];
  footnotes?: FootnoteCache[];
  footnoteRefs?: FootnoteRefCache[];
  referenceLinks?: ReferenceLinkCache[];
  sections?: SectionCache[];
  listItems?: ListItemCache[];
  frontmatter?: FrontMatterCache;
  frontmatterPosition?: Pos;
  frontmatterLinks?: FrontmatterLinkCache[];
  blocks?: Record<string, BlockCache>;
}
