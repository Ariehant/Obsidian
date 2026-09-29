/**
 * Callout types. Aliases and the default icon per type follow the public documentation;
 * colours live in CSS (`--callout-*` variables on `.callout[data-callout="…"]`).
 */

export interface CalloutType {
  /** Canonical type used for colour and icon. */
  type: string;
  icon: string;
}

const TYPES: Record<string, { icon: string; aliases: string[] }> = {
  note: { icon: 'pencil', aliases: [] },
  abstract: { icon: 'clipboard-list', aliases: ['summary', 'tldr'] },
  info: { icon: 'info', aliases: [] },
  todo: { icon: 'circle-check', aliases: [] },
  tip: { icon: 'flame', aliases: ['hint', 'important'] },
  success: { icon: 'check', aliases: ['check', 'done'] },
  question: { icon: 'circle-help', aliases: ['help', 'faq'] },
  warning: { icon: 'triangle-alert', aliases: ['caution', 'attention'] },
  failure: { icon: 'x', aliases: ['fail', 'missing'] },
  danger: { icon: 'zap', aliases: ['error'] },
  bug: { icon: 'bug', aliases: [] },
  example: { icon: 'list', aliases: [] },
  quote: { icon: 'quote', aliases: ['cite'] },
};

const LOOKUP = new Map<string, CalloutType>();
for (const [type, { icon, aliases }] of Object.entries(TYPES)) {
  for (const name of [type, ...aliases]) LOOKUP.set(name, { type, icon });
}

/** Resolves a callout name (case-insensitive). Unknown names behave like `note`. */
export function calloutType(name: string): CalloutType {
  return LOOKUP.get(name.toLowerCase()) ?? { type: 'note', icon: 'pencil' };
}

export interface CalloutHeader {
  /** Type as written, lower-cased (`[!TIP]` → `tip`). Used for `data-callout`. */
  name: string;
  /** Text after `|` inside the brackets, used for `data-callout-metadata`. */
  metadata: string;
  /** `+` expanded but foldable, `-` collapsed, `` not foldable. */
  fold: '' | '+' | '-';
  /** Offset of the custom title within the header line, or -1 when there is none. */
  titleOffset: number;
}

const HeaderRe = /^\[!([^\]|]+)(?:\|([^\]]*))?\]([+-]?)(?:[ \t]+(\S.*?))?[ \t]*$/d;

/** Parses the first line of a blockquote (without `>`) as a callout header. */
export function parseCalloutHeader(line: string): CalloutHeader | null {
  const m = HeaderRe.exec(line);
  if (!m) return null;
  return {
    name: m[1]!.trim().toLowerCase(),
    metadata: (m[2] ?? '').trim(),
    fold: (m[3] ?? '') as CalloutHeader['fold'],
    titleOffset: m.indices?.[4]?.[0] ?? -1,
  };
}

/** Default title: the name as written, capitalised (`tldr` → `Tldr`). */
export function defaultCalloutTitle(name: string): string {
  return name ? name[0]!.toUpperCase() + name.slice(1) : 'Note';
}
