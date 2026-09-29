import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { editorContent, fileTitle, launch, makeVault } from './helpers';

let tmp: string;
let vaultDir: string;
let app: ElectronApplication;
let page: Page;
let errors: string[];

const reading = () => page.locator('.markdown-reading-view .markdown-preview-sizer');
const readVaultFile = (p: string) => fs.readFile(path.join(vaultDir, p), 'utf8');

test.beforeEach(async () => {
  ({ tmp, vaultDir } = await makeVault());
  ({ app, page, errors } = await launch(tmp, { BASALT_VAULT: vaultDir }));
  await fileTitle(page, 'Showcase.md').click();
  await expect(page.locator('.view-header-title')).toHaveText('Showcase');
});

test.afterEach(async () => {
  await app?.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

test.describe('Live Preview', () => {
  test('hides syntax away from the cursor and renders blocks', async () => {
    const content = editorContent(page);
    // The cursor starts on the first line, so its heading mark is visible…
    await expect(content.locator('.cm-line').first()).toHaveText('# Showcase');
    // …while the link alias, callout, table and checkboxes render.
    await expect(content.locator('[data-href="Robot arm"]')).toHaveText('the arm');
    await expect(content.locator('.cm-embed-block .callout[data-callout="tip"]')).toBeVisible();
    await expect(content.locator('.cm-embed-block table td').first()).toHaveText('Base');
    await expect(content.locator('input.task-list-item-checkbox')).toHaveCount(2);
    await expect(content.locator('.math mjx-container').first()).toBeVisible();
  });

  test('toggles a task from its checkbox and saves it', async () => {
    await editorContent(page).locator('input.task-list-item-checkbox').first().click();
    await expect
      .poll(() => readVaultFile('Showcase.md'), { timeout: 6000 })
      .toContain('- [x] Calibrate encoders');
  });

  test('follows a wikilink on click', async () => {
    await editorContent(page).locator('[data-href="Robot arm"]').click();
    await expect(page.locator('.view-header-title')).toHaveText('Robot arm');
    await expect(fileTitle(page, 'Projects/Robot arm.md')).toHaveClass(/is-active/);
  });

  test('creates a note when an unresolved link is followed', async () => {
    const link = editorContent(page).locator('[data-href="Brand new note"]');
    await expect(link).toHaveClass(/is-unresolved/);
    await link.click();
    await expect(page.locator('.view-header-title')).toHaveText('Brand new note');
    expect(await readVaultFile('Brand new note.md')).toBe('');
  });

  test('never creates files outside the vault from a link', async () => {
    await editorContent(page).locator('[data-href="../../outside.md"]').click();
    await page.waitForTimeout(300);
    await expect(fs.stat(path.join(tmp, '..', 'outside.md'))).rejects.toThrow();
    await expect(page.locator('.view-header-title')).toHaveText('Showcase');
  });

  test('switches to source mode from the status bar', async () => {
    await page.locator('.plugin-editor-status').click();
    await expect(page.locator('.plugin-editor-status')).toHaveText('Source mode');
    await expect(editorContent(page)).toContainText('[[Robot arm|the arm]]');
    await expect(editorContent(page)).toContainText('> [!tip] Callout title');
  });
});

test.describe('Reading view', () => {
  test.beforeEach(async () => {
    await page.keyboard.press('ControlOrMeta+E');
    await expect(page.locator('.plugin-editor-status')).toHaveText('Reading');
  });

  test('renders callouts, tables, math, tasks and embeds', async () => {
    const view = reading();
    await expect(view.locator('.callout[data-callout="tip"] .callout-title-inner')).toHaveText(
      'Callout title',
    );
    await expect(view.locator('.callout .callout-icon svg')).toHaveCount(1);
    await expect(view.locator('table th').first()).toHaveText('Joint');
    await expect(view.locator('.math-inline mjx-container svg')).toBeVisible();
    await expect(view.locator('li.task-list-item.is-checked')).toHaveText('Mount motors');

    // The image embed loads through the app:// protocol.
    const img = view.locator('.image-embed img');
    await expect(img).toHaveAttribute('src', /^app:\/\/local\/.+diagram\.png\?\d+$/);
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1);
  });

  test('sanitises raw HTML in notes', async () => {
    await expect(reading().locator('h1')).toHaveText('Showcase');
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
    await expect(reading().locator('script')).toHaveCount(0);
    await expect(reading().locator('[onerror]')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('toggles tasks in the file', async () => {
    await reading().locator('input.task-list-item-checkbox').first().click();
    await expect.poll(() => readVaultFile('Showcase.md')).toContain('- [x] Calibrate encoders');
    await expect(reading().locator('li.task-list-item.is-checked')).toHaveCount(2);
  });

  test('follows internal links and returns to editing', async () => {
    await reading().locator('a.internal-link[data-href="Robot arm"]').click();
    await expect(page.locator('.view-header-title')).toHaveText('Robot arm');
    await expect(reading().locator('h1')).toHaveText('Robot arm');
    await page.locator('.view-action').click();
    await expect(page.locator('.plugin-editor-status')).toHaveText('Live Preview');
    await expect(editorContent(page)).toBeVisible();
  });
});
