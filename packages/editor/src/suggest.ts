/**
 * Autocomplete for `[[links]]` (files, then `#headings` and `#^blocks` within a target) and
 * `#tags`. Suggestions come from the editor host; ranking uses the API's fuzzy search.
 */
import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import type { EditorView } from '@codemirror/view';
import { fuzzySort } from '@basalt/core/src/search';
import type { LinkedFile } from '@basalt/markdown';
import { editorHost } from './live-preview';

export interface SuggestHost {
  /** Link targets: every file, with aliases for notes. */
  files(): Array<{ file: LinkedFile; aliases?: string[] }>;
  /** Shortest link text to `file` from the note being edited. */
  linktext(file: LinkedFile): string;
  /** Headings of the note a link path points at ('' = the current note). */
  headings(linkpath: string): string[];
  /** Block ids (with a text preview) of the note a link path points at. */
  blocks(linkpath: string): Array<{ id: string; text: string }>;
  /** Every tag in the vault, with `#`. */
  tags(): string[];
}

const MAX_OPTIONS = 50;

/** Fuzzy match ranges per option, so the dropdown highlights what matched. */
const matchRanges = new WeakMap<Completion, number[]>();
const getMatch = (c: Completion) => matchRanges.get(c) ?? [];

function withMatch<T extends Completion>(option: T, matches: Array<[number, number]>): T {
  matchRanges.set(option, matches.flat());
  return option;
}

/** Inserts `text`, adding `]]` unless the link is already closed after the cursor. */
function insertLinkPart(text: string, closing: boolean) {
  return (view: EditorView, _c: Completion, from: number, to: number) => {
    const after = view.state.doc.sliceString(to, to + 2);
    const close = closing && after !== ']]' ? ']]' : '';
    const end = from + text.length + (after === ']]' && closing ? 2 : close.length);
    view.dispatch({ changes: { from, to, insert: text + close }, selection: { anchor: end } });
  };
}

function linkCompletion(context: CompletionContext): CompletionResult | null {
  const suggest = context.state.facet(editorHost)?.suggest;
  if (!suggest) return null;
  const before = context.matchBefore(/!?\[\[[^[\]]*$/);
  if (!before) return null;
  const prefix = before.text.startsWith('!') ? 3 : 2;
  const inner = before.text.slice(prefix);
  if (inner.includes('|')) return null;
  const start = before.from + prefix;

  const hash = inner.indexOf('#');
  if (hash !== -1) {
    const linkpath = inner.slice(0, hash);
    const rest = inner.slice(hash + 1);
    if (rest.startsWith('^')) {
      const blocks = fuzzySort(suggest.blocks(linkpath), rest.slice(1), (b) => `${b.id} ${b.text}`);
      return {
        from: start + hash + 2,
        filter: false,
        options: blocks.slice(0, MAX_OPTIONS).map(({ item }) => ({
          label: item.id,
          detail: item.text.slice(0, 80),
          type: 'block',
          apply: insertLinkPart(item.id, true),
        })),
      };
    }
    const headings = fuzzySort(suggest.headings(linkpath), rest, (h) => h);
    return {
      from: start + hash + 1,
      filter: false,
      getMatch,
      options: headings
        .slice(0, MAX_OPTIONS)
        .map(({ item, match }) =>
          withMatch({ label: item, type: 'heading', apply: insertLinkPart(item, true) }, match.matches),
        ),
    };
  }

  type Entry = { file: LinkedFile; alias: string | null; text: string };
  const entries: Entry[] = [];
  for (const { file, aliases } of suggest.files()) {
    const name = file.extension === 'md' ? file.basename : `${file.basename}.${file.extension}`;
    entries.push({ file, alias: null, text: name });
    for (const alias of aliases ?? []) entries.push({ file, alias, text: alias });
  }
  let ranked = fuzzySort(entries, inner, (e) => e.text);
  // Fall back to matching the whole path (`folder/note`) when names don't match.
  if (!ranked.length)
    ranked = fuzzySort(
      entries.filter((e) => !e.alias),
      inner,
      (e) => e.file.path,
    );
  return {
    from: start,
    filter: false,
    getMatch,
    options: ranked.slice(0, MAX_OPTIONS).map(({ item, match }) => {
      const folder = item.file.path.includes('/')
        ? item.file.path.slice(0, item.file.path.lastIndexOf('/'))
        : '';
      const linktext = suggest.linktext(item.file);
      const option = {
        label: item.text,
        detail: item.alias ? `→ ${item.file.basename}` : folder,
        type: item.file.extension === 'md' ? 'note' : 'file',
        apply: insertLinkPart(item.alias ? `${linktext}|${item.alias}` : linktext, true),
      };
      // Path matches don't line up with the label, so only name matches are highlighted.
      return option.label === item.text && match.matches.every(([, e]) => e <= item.text.length)
        ? withMatch(option, match.matches)
        : option;
    }),
  };
}

function tagCompletion(context: CompletionContext): CompletionResult | null {
  const suggest = context.state.facet(editorHost)?.suggest;
  if (!suggest) return null;
  const before = context.matchBefore(/(?:^|[\s(])#[\p{L}\p{N}_/-]+$/u);
  if (!before) return null;
  const hashPos = before.from + before.text.indexOf('#');
  const query = context.state.doc.sliceString(hashPos + 1, context.pos);
  const tags = fuzzySort(
    suggest.tags().map((t) => t.replace(/^#/, '')),
    query,
    (t) => t,
  );
  if (!tags.length) return null;
  return {
    from: hashPos + 1,
    filter: false,
    getMatch,
    options: tags
      .slice(0, MAX_OPTIONS)
      .map(({ item, match }) => withMatch({ label: item, type: 'tag' }, match.matches)),
  };
}

/** Link and tag completion for the Markdown editor. */
export function obsidianAutocomplete() {
  return autocompletion({
    override: [linkCompletion, tagCompletion],
    icons: false,
    tooltipClass: () => 'suggestion-container',
    optionClass: () => 'suggestion-item',
  });
}
