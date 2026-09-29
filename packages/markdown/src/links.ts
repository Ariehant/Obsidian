/** Link-text helpers matching the plugin API (`parseLinktext`, `getLinkpath`). */

export interface ParsedLinktext {
  /** File part, e.g. `Folder/Note` in `Folder/Note#Heading`. May be empty for same-file links. */
  path: string;
  /** Everything from the first `#`, e.g. `#Heading` or `#^block`. Empty when absent. */
  subpath: string;
}

export function parseLinktext(linktext: string): ParsedLinktext {
  const idx = linktext.indexOf('#');
  if (idx === -1) return { path: linktext.trim(), subpath: '' };
  return { path: linktext.slice(0, idx).trim(), subpath: linktext.slice(idx).trim() };
}

export function getLinkpath(linktext: string): string {
  return parseLinktext(linktext).path;
}

/** `#A#B` → ['A', 'B']; `#^id` → { block: 'id' }. */
export function parseSubpath(subpath: string): { headings: string[]; block: string | null } {
  const body = subpath.replace(/^#/, '');
  if (body.startsWith('^')) return { headings: [], block: body.slice(1) };
  return {
    headings: body
      ? body
          .split('#')
          .map((h) => h.trim())
          .filter(Boolean)
      : [],
    block: null,
  };
}

/** Whether a Markdown link destination points outside the vault (has a URL scheme). */
export function isExternalUrl(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(url);
}

/** Display text for a wikilink without alias: `Note#Heading` → `Note > Heading`. */
export function linktextDisplay(linktext: string): string {
  const { path, subpath } = parseLinktext(linktext);
  const { headings, block } = parseSubpath(subpath);
  const parts = [path, ...headings, ...(block ? [`^${block}`] : [])].filter(Boolean);
  return parts.join(' > ');
}
