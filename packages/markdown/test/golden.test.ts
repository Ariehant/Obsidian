/**
 * Golden tests for Obsidian-flavoured Markdown: fixtures/markdown/<name>.md renders to
 * the checked-in <name>.html. To accept an intended change, review the diff and run
 * `npx vitest run packages/markdown -u`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { markdownToHtml } from '../src/html';

const DIR = path.resolve(__dirname, '../../../fixtures/markdown');
const cases = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith('.md'))
  .map((f) => f.slice(0, -3));

describe('OFM golden fixtures', () => {
  it.each(cases)('%s', async (name) => {
    const source = fs.readFileSync(path.join(DIR, `${name}.md`), 'utf8');
    await expect(markdownToHtml(source)).toMatchFileSnapshot(path.join(DIR, `${name}.html`));
  });
});
