import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileTitle, folderTitle, launch, makeVault } from './helpers';

let tmp: string;
let vaultDir: string;
let app: ElectronApplication;
let page: Page;

const pane = (type: string) => page.locator(`.workspace-leaf-content[data-type="${type}"]`);
const tab = (type: string) => page.locator(`.workspace-tab-header[data-type="${type}"]`);

test.beforeEach(async () => {
  ({ tmp, vaultDir } = await makeVault());
  await fs.writeFile(
    path.join(vaultDir, 'Log.md'),
    '# Log\n\nTuned the robot arm today. #robotics/arm\n\n## Notes\n\n### Gains\n\nKp up. #robotics\n',
  );
  ({ app, page } = await launch(tmp, { BASALT_VAULT: vaultDir }));
  await page.waitForFunction(() => window.app?.metadataCache.isResolved());
  await folderTitle(page, 'Projects').click();
  await fileTitle(page, 'Projects/Robot arm.md').click();
});

test.afterEach(async () => {
  await app?.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

test('backlinks list linked mentions and open the source at the link', async () => {
  const backlinks = pane('backlink');
  await expect(backlinks.locator('.search-result-file-title .tree-item-inner')).toHaveText([
    'Showcase',
    'Welcome',
  ]);
  await expect(backlinks.locator('.search-result-file-matched-text').first()).toHaveText(
    '[[Robot arm|the arm]]',
  );

  await backlinks.locator('.search-result-file-match').first().click();
  await expect(page.locator('.view-header-title')).toHaveText('Showcase');
  const selected = await page.evaluate(() => window.getSelection()?.toString());
  expect(selected).toContain('Robot arm');
});

test('unlinked mentions can be turned into links', async () => {
  const backlinks = pane('backlink');
  await backlinks.locator('.tree-item-self', { hasText: 'Unlinked mentions' }).click();
  // Unlinked rows are the ones with a Link button.
  const match = backlinks.locator('.search-result-file-match:has(.search-result-hover-button)');
  await expect(match).toHaveCount(1);
  await expect(match.locator('.search-result-file-matched-text')).toHaveText('robot arm');
  await match.hover();
  await match.getByRole('button', { name: 'Link' }).click();
  await expect
    .poll(() => fs.readFile(path.join(vaultDir, 'Log.md'), 'utf8'))
    .toContain('Tuned the [[Robot arm|robot arm]] today.');
  await expect(backlinks.locator('.search-result-file-title .tree-item-inner')).toContainText(['Log']);
});

test('outline lists nested headings and jumps to them', async () => {
  await fileTitle(page, 'Log.md').click();
  await tab('outline').click();
  const outline = pane('outline');
  await expect(outline.locator('.tree-item-inner')).toHaveText(['Log', 'Notes', 'Gains']);
  await expect(outline.locator('.tree-item-self[data-level="3"]')).toHaveText('Gains');
  await outline.locator('.tree-item-self', { hasText: 'Gains' }).click();
  const cursorLine = () =>
    page.evaluate(() => window.getSelection()?.anchorNode?.parentElement?.closest('.cm-line')?.textContent);
  await expect.poll(cursorLine).toBe('### Gains');
});

test('outgoing links show resolved and unresolved targets', async () => {
  await fileTitle(page, 'Showcase.md').click();
  await tab('outgoing-link').click();
  const outgoing = pane('outgoing-link');
  await expect(outgoing.locator('.search-result-file-title:not(.is-unresolved) .tree-item-inner')).toHaveText(
    ['diagram.png', 'Robot arm'],
  );
  await expect(outgoing.locator('.search-result-file-title.is-unresolved .tree-item-inner')).toContainText([
    'Brand new note',
  ]);
});

test('tags pane counts nested tags', async () => {
  await tab('tag').click();
  const tags = pane('tag');
  // #robotics in Log, #robotics/arm in Log, and frontmatter tags in Kinematics.
  await expect(tags.locator('.tag-pane-tag[data-tag="#robotics"] .tag-pane-tag-count')).toHaveText('3');
  await expect(tags.locator('.tag-pane-tag[data-tag="#theory"]')).toBeVisible();
  await expect(tags.locator('.tag-pane-tag[data-tag="#robotics/arm"] .tag-pane-tag-text')).toHaveText('arm');
});
