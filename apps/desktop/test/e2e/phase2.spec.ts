import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { editorContent, fileTitle, folderTitle, launch, makeVault } from './helpers';

let tmp: string;
let vaultDir: string;
let app: ElectronApplication;
let page: Page;

const read = (p: string) => fs.readFile(path.join(vaultDir, p), 'utf8');

test.beforeEach(async () => {
  ({ tmp, vaultDir } = await makeVault());
  ({ app, page } = await launch(tmp, { BASALT_VAULT: vaultDir }));
  await page.waitForFunction(() => window.app?.metadataCache.isResolved());
});

test.afterEach(async () => {
  await app?.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

test('autocompletes links and headings', async () => {
  await fileTitle(page, 'Welcome.md').click();
  await editorContent(page).click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('\n[[kinem');
  const options = page.locator('.suggestion-container .suggestion-item');
  await expect(options.first()).toContainText('Kinematics');
  // CodeMirror ignores Enter for 75 ms after the list opens (protects fast typists).
  await page.waitForTimeout(150);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('#inv');
  await expect(options.first()).toContainText('Inverse');
  await page.waitForTimeout(150);
  await page.keyboard.press('Enter');
  await expect.poll(() => read('Welcome.md'), { timeout: 6000 }).toContain('[[Kinematics#Inverse]]');
});

test('shows a hover preview of a linked note in the reading view', async () => {
  await fileTitle(page, 'Showcase.md').click();
  await page.keyboard.press('ControlOrMeta+E');
  await page.locator('.markdown-reading-view a.internal-link[data-href="Robot arm"]').hover();
  const popover = page.locator('.popover.hover-popover');
  await expect(popover.locator('h1')).toHaveText('Robot arm');
  await page.mouse.move(5, 400);
  await expect(popover).toHaveCount(0);
});

test('pastes an image as an attachment and embeds it', async () => {
  await fileTitle(page, 'Welcome.md').click();
  await editorContent(page).click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.evaluate(() => {
    const png = Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      ),
      (c) => c.charCodeAt(0),
    );
    const dt = new DataTransfer();
    dt.items.add(new File([png], 'image.png', { type: 'image/png' }));
    document
      .querySelector('.cm-content')!
      .dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await expect.poll(() => read('Welcome.md'), { timeout: 6000 }).toMatch(/!\[\[Pasted image \d{14}\.png\]\]/);
  const files = await fs.readdir(vaultDir);
  expect(files.some((f) => /^Pasted image \d{14}\.png$/.test(f))).toBe(true);
});

test('imports files dropped on the explorer', async () => {
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['measured data'], 'readings.csv', { type: 'text/csv' }));
    const target = document.querySelector('.nav-folder-title[data-path="Daily"]')!;
    for (const type of ['dragover', 'drop']) {
      target.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
    }
  });
  await expect(fileTitle(page, 'Daily/readings.csv')).toBeVisible();
  expect(await read('Daily/readings.csv')).toBe('measured data');
});

test('shows and edits properties', async () => {
  await folderTitle(page, 'Projects').click();
  await folderTitle(page, 'Projects/Notes').click();
  await fileTitle(page, 'Projects/Notes/Kinematics.md').click();
  // The cursor starts in the frontmatter; move it out to show the properties widget.
  await page.keyboard.press('ControlOrMeta+End');
  const props = editorContent(page).locator('.metadata-container');
  await expect(props.locator('.metadata-property')).toHaveCount(4);
  await expect(props.locator('[data-property-key="updated"]')).toHaveAttribute('data-property-type', 'date');

  await props.locator('[data-property-key="reviewed"] input[type="checkbox"]').check();
  await expect
    .poll(() => read('Projects/Notes/Kinematics.md'), { timeout: 6000 })
    .toContain('reviewed: true');

  await page.keyboard.press('ControlOrMeta+E');
  const reading = page.locator('.markdown-reading-view .metadata-container');
  await expect(reading.locator('[data-property-key="tags"] .multi-select-pill')).toHaveText([
    '#robotics',
    '#theory',
  ]);
  await expect(reading.locator('[data-property-key="status"]')).toContainText('draft');
});
