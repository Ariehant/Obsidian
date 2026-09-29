/**
 * Grades the renderer's CommonMark flavour against the official spec examples.
 *
 * The parser (@lezer/markdown) is spec-compliant, so failures here are renderer bugs.
 * KNOWN_FAILURES lists examples we don't pass yet. The test fails if one of them starts
 * passing (so the list stays honest) or if any other example fails.
 */
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { markdownToHtml } from '../src/html';

const require = createRequire(import.meta.url);
const spec = require('commonmark-spec') as {
  tests: Array<{ markdown: string; html: string; section: string; number: number }>;
};

/** Normalises insignificant differences, like the reference test harness does. */
function normalize(html: string): string {
  return html
    .replace(/\r\n?/g, '\n')
    .replace(/>\n+</g, '><')
    .replace(/\n+$/, '')
    .replace(/ \/>/g, '>')
    .trim();
}

/**
 * Parser-level differences in @lezer/markdown, not renderer bugs:
 * - 5, 6, 7, 10: partial tab expansion inside containers / after `#`.
 * - 171: `<textarea>` as an HTML block start condition (added in spec 0.31).
 * - 280: a list item that starts with a blank line may not continue past it.
 * - 493, 512, 523, 528, 569, 571: bracket pairing in links; lezer pairs brackets without
 *   knowing which reference definitions exist.
 * - 621, 625, 626: inline raw-HTML and comment edge cases changed in spec 0.31.
 */
const KNOWN_FAILURES = new Set<number>([5, 6, 7, 10, 171, 280, 493, 512, 523, 528, 569, 571, 621, 625, 626]);

describe('CommonMark spec', () => {
  const results = spec.tests.map((t) => {
    const md = t.markdown.replace(/→/g, '\t');
    const expected = t.html.replace(/→/g, '\t');
    const actual = markdownToHtml(md, { flavor: 'commonmark' });
    return { ...t, md, expected, actual, pass: normalize(actual) === normalize(expected) };
  });

  it('passes every example not listed as a known failure', () => {
    const unexpected = results.filter((r) => !r.pass && !KNOWN_FAILURES.has(r.number));
    const report = unexpected
      .slice(0, 15)
      .map(
        (r) =>
          `#${r.number} (${r.section})\n  md:       ${JSON.stringify(r.md)}\n  expected: ${JSON.stringify(r.expected)}\n  actual:   ${JSON.stringify(r.actual)}`,
      )
      .join('\n');
    const passed = results.filter((r) => r.pass).length;
    expect(
      unexpected.map((r) => r.number),
      `${passed}/${results.length} pass\n${report}`,
    ).toEqual([]);
  });

  it('keeps the known-failure list current', () => {
    const fixed = results.filter((r) => r.pass && KNOWN_FAILURES.has(r.number)).map((r) => r.number);
    expect(fixed, 'these now pass; remove them from KNOWN_FAILURES').toEqual([]);
  });
});
