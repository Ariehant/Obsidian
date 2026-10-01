/**
 * Text matching for suggestions, matching the plugin API's `prepareFuzzySearch`,
 * `prepareSimpleSearch` and `SearchResult`.
 *
 * Scores are ≤ 0; closer to 0 is a better match. `matches` are [start, end) ranges of the
 * matched characters in the searched text, for highlighting.
 */

export type SearchMatchPart = [number, number];
export type SearchMatches = SearchMatchPart[];

export interface SearchResult {
  score: number;
  matches: SearchMatches;
}

const isWordStart = (text: string, i: number) =>
  i === 0 || /[\s\-_/.()[\]]/.test(text[i - 1]!) || (/[a-z]/.test(text[i - 1]!) && /[A-Z]/.test(text[i]!));

function isSubsequence(q: string, from: number, text: string, start: number): boolean {
  let pos = start;
  for (let k = from; k < q.length; k++) {
    pos = text.indexOf(q[k]!, pos);
    if (pos === -1) return false;
    pos++;
  }
  return true;
}

function pushMatch(matches: SearchMatches, i: number): void {
  const last = matches[matches.length - 1];
  if (last && last[1] === i) last[1] = i + 1;
  else matches.push([i, i + 1]);
}

/**
 * Characters of the query must appear in order. Consecutive runs and runs that begin at a
 * word start score better; gaps and an offset first match cost.
 */
export function prepareFuzzySearch(query: string): (text: string) => SearchResult | null {
  const q = query.toLowerCase().replace(/\s+/g, '');
  return (text: string) => {
    if (!q) return { score: 0, matches: [] };
    const lower = text.toLowerCase();

    // Greedy forward pass, preferring word starts when the character also appears there.
    const matches: SearchMatches = [];
    let score = 0;
    let pos = 0;
    let prev = -2;
    for (let k = 0; k < q.length; k++) {
      const ch = q[k]!;
      let idx = lower.indexOf(ch, pos);
      if (idx === -1) return null;
      if (idx !== prev + 1) {
        // Prefer the same character at a later word start, but only if the rest of the
        // query can still match after it.
        for (let j = lower.indexOf(ch, idx + 1); j !== -1 && j - idx <= 20; j = lower.indexOf(ch, j + 1)) {
          if (isWordStart(text, j) && !isWordStart(text, idx) && isSubsequence(q, k + 1, lower, j + 1)) {
            idx = j;
            break;
          }
        }
      }
      if (prev < 0) {
        // Where the match starts matters a little; starting mid-word matters more.
        score -= 0.1 * idx + (isWordStart(text, idx) ? 0 : 3);
      } else if (idx !== prev + 1) {
        // A gap: cheaper when the next run begins a word.
        score -= 1 + 0.1 * (idx - pos) + (isWordStart(text, idx) ? 0 : 1);
      }
      pushMatch(matches, idx);
      prev = idx;
      pos = idx + 1;
    }
    // Shorter texts with the same matches rank higher.
    score -= (text.length - q.length) * 0.01;
    return { score, matches };
  };
}

/** Every space-separated word of the query must appear (case-insensitive). */
export function prepareSimpleSearch(query: string): (text: string) => SearchResult | null {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return (text: string) => {
    const lower = text.toLowerCase();
    const matches: SearchMatches = [];
    let score = 0;
    for (const w of words) {
      const idx = lower.indexOf(w);
      if (idx === -1) return null;
      matches.push([idx, idx + w.length]);
      score -= idx * 0.01;
    }
    matches.sort((a, b) => a[0] - b[0]);
    return { score, matches };
  };
}

/** Appends `text` to `el` with matched ranges wrapped in `span.suggestion-highlight`. */
export function renderMatches(
  el: HTMLElement,
  text: string,
  matches: SearchMatches | null,
  offset = 0,
): void {
  let pos = 0;
  const doc = el.ownerDocument;
  for (const [s, e] of matches ?? []) {
    const start = s + offset;
    const end = e + offset;
    if (end <= 0 || start >= text.length) continue;
    const a = Math.max(start, 0);
    if (a > pos) el.appendChild(doc.createTextNode(text.slice(pos, a)));
    const span = doc.createElement('span');
    span.className = 'suggestion-highlight';
    span.textContent = text.slice(a, Math.min(end, text.length));
    el.appendChild(span);
    pos = Math.min(end, text.length);
  }
  if (pos < text.length) el.appendChild(doc.createTextNode(text.slice(pos)));
}

/** Plugin API name for highlighting a search result. */
export function renderResults(el: HTMLElement, text: string, result: SearchResult, offset?: number): void {
  renderMatches(el, text, result.matches, offset);
}

/** Sorts items by fuzzy score against `query`, dropping non-matches. */
export function fuzzySort<T>(
  items: T[],
  query: string,
  text: (item: T) => string,
): Array<{ item: T; match: SearchResult }> {
  const search = prepareFuzzySearch(query);
  const out: Array<{ item: T; match: SearchResult }> = [];
  for (const item of items) {
    const match = search(text(item));
    if (match) out.push({ item, match });
  }
  return out.sort((a, b) => b.match.score - a.match.score);
}
