/**
 * YAML frontmatter helpers matching the plugin API: `parseYaml`, `stringifyYaml`,
 * `getFrontMatterInfo`, `parseFrontMatterTags`, `parseFrontMatterAliases`, `getAllTags`.
 */
import { parse, stringify } from 'yaml';
import type { CachedMetadata } from './metadata-types';

export function parseYaml(yaml: string): any {
  return parse(yaml);
}

export function stringifyYaml(obj: any): string {
  return stringify(obj, { lineWidth: 0 });
}

export interface FrontMatterInfo {
  exists: boolean;
  /** The YAML between the fences. */
  frontmatter: string;
  /** Offset where the YAML starts (after the opening fence's newline). */
  from: number;
  /** Offset where the YAML ends (before the closing fence). */
  to: number;
  /** Offset where the note body starts (after the closing fence's newline). */
  contentStart: number;
}

const FrontmatterRe = /^---[ \t]*\r?\n([\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/;

export function getFrontMatterInfo(content: string): FrontMatterInfo {
  const m = FrontmatterRe.exec(content);
  if (!m) return { exists: false, frontmatter: '', from: 0, to: 0, contentStart: 0 };
  const from = content.indexOf('\n') + 1;
  const yaml = m[1] ?? '';
  return { exists: true, frontmatter: yaml, from, to: from + yaml.length, contentStart: m[0].length };
}

/** Values of a frontmatter list key, accepting a YAML list or a comma/space separated string. */
function listValues(frontmatter: any, keys: string[], splitOnSpace: boolean): string[] | null {
  if (!frontmatter || typeof frontmatter !== 'object') return null;
  const out: string[] = [];
  for (const key of keys) {
    const actual = Object.keys(frontmatter).find((k) => k.toLowerCase() === key);
    if (actual === undefined) continue;
    const value = frontmatter[actual];
    const items = Array.isArray(value)
      ? value
      : typeof value === 'string'
        ? value.split(splitOnSpace ? /[,\s]+/ : /,/)
        : [];
    for (const item of items) {
      if (item === null || item === undefined) continue;
      const s = String(item).trim();
      if (s) out.push(s);
    }
  }
  return out.length ? out : null;
}

/** `tags`/`tag` frontmatter as `#tag` strings. */
export function parseFrontMatterTags(frontmatter: any | null): string[] | null {
  const tags = listValues(frontmatter, ['tags', 'tag'], true);
  return tags ? tags.map((t) => (t.startsWith('#') ? t : `#${t}`)) : null;
}

/** `aliases`/`alias` frontmatter. */
export function parseFrontMatterAliases(frontmatter: any | null): string[] | null {
  return listValues(frontmatter, ['aliases', 'alias'], false);
}

/** Frontmatter tags followed by body tags, each with a leading `#`. */
export function getAllTags(cache: CachedMetadata): string[] | null {
  const tags = [...(parseFrontMatterTags(cache.frontmatter) ?? []), ...(cache.tags ?? []).map((t) => t.tag)];
  return tags.length ? tags : null;
}
