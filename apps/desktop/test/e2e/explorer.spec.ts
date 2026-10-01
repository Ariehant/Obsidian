import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileTitle, folderTitle, launch, makeVault } from './helpers';

let tmp: string;
let vaultDir: string;
let app: ElectronApplication;
let page: Page;

const exists = (p: string) =>
  fs.stat(path.join(vaultDir, p)).then(
    () => true,
    () => false,
  );
const menuItem = (title: string) => page.locator('.menu .menu-item', { hasText: title });

test.beforeEach(async () => {
  ({ tmp, vaultDir } = await makeVault());
  ({ app, page } = await launch(tmp, { BASALT_VAULT: vaultDir }));
  await expect(fileTitle(page, 'Welcome.md')).toBeVisible();
});

test.afterEach(async () => {
  await app?.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

test('shows file and folder context menus', async () => {
  await fileTitle(page, 'Welcome.md').click({ button: 'right' });
  await expect(page.locator('.menu .menu-item')).toHaveText([
    'Make a copy',
    'Rename...',
    'Copy path',
    'Reveal in system explorer',
    'Delete',
  ]);
  await page.keyboard.press('Escape');
  await expect(page.locator('.menu')).toHaveCount(0);

  await folderTitle(page, 'Projects').click({ button: 'right' });
  await expect(page.locator('.menu .menu-item').first()).toHaveText('New note');
});

test('renames from the context menu', async () => {
  await fileTitle(page, 'Welcome.md').click({ button: 'right' });
  await menuItem('Rename...').click();
  await expect(fileTitle(page, 'Welcome.md').locator('.tree-item-inner')).toBeFocused();
  await page.keyboard.type('Start here');
  await page.keyboard.press('Enter');
  await expect(fileTitle(page, 'Start here.md')).toBeVisible();
  expect(await exists('Start here.md')).toBe(true);
  expect(await exists('Welcome.md')).toBe(false);
});

test('asks before deleting and can be cancelled', async () => {
  await fileTitle(page, 'Welcome.md').click({ button: 'right' });
  await menuItem('Delete').click();
  const modal = page.locator('.modal.mod-confirmation');
  await expect(modal.locator('.modal-title')).toHaveText('Delete file');
  await modal.getByRole('button', { name: 'Cancel' }).click();
  await expect(modal).toHaveCount(0);
  expect(await exists('Welcome.md')).toBe(true);

  await fileTitle(page, 'Welcome.md').click({ button: 'right' });
  await menuItem('Delete').click();
  await page.locator('.modal.mod-confirmation').getByRole('button', { name: 'Delete' }).click();
  await expect(fileTitle(page, 'Welcome.md')).toHaveCount(0);
  expect(await exists('Welcome.md')).toBe(false);
});

test('creates a note inside a folder and makes copies', async () => {
  await folderTitle(page, 'Daily').click({ button: 'right' });
  await menuItem('New note').click();
  await expect(fileTitle(page, 'Daily/Untitled.md')).toHaveClass(/is-active/);
  expect(await exists('Daily/Untitled.md')).toBe(true);

  await fileTitle(page, 'Welcome.md').click({ button: 'right' });
  await menuItem('Make a copy').click();
  await expect(fileTitle(page, 'Welcome 1.md')).toBeVisible();
  expect(await fs.readFile(path.join(vaultDir, 'Welcome 1.md'), 'utf8')).toContain('# Welcome');
});

test('moves files and folders by drag and drop', async () => {
  await fileTitle(page, 'Welcome.md').dragTo(folderTitle(page, 'Daily'));
  await expect(fileTitle(page, 'Daily/Welcome.md')).toBeVisible();
  expect(await exists('Daily/Welcome.md')).toBe(true);

  await folderTitle(page, 'Daily').dragTo(folderTitle(page, 'Projects'));
  await expect(folderTitle(page, 'Projects/Daily')).toBeVisible();
  expect(await exists('Projects/Daily/Welcome.md')).toBe(true);

  // A folder can't be dropped into its own descendant.
  await folderTitle(page, 'Projects').dragTo(folderTitle(page, 'Projects/Daily'));
  expect(await exists('Projects/Daily')).toBe(true);
});

test('keeps expanded folders open across external changes', async () => {
  await folderTitle(page, 'Projects').click();
  await folderTitle(page, 'Projects/Notes').click();
  await expect(fileTitle(page, 'Projects/Notes/Kinematics.md')).toBeVisible();

  await fs.writeFile(path.join(vaultDir, 'Projects/Notes/Dynamics.md'), '# Dynamics');
  await expect(fileTitle(page, 'Projects/Notes/Dynamics.md')).toBeVisible();
  // Inserted in sorted position, and the tree stayed expanded.
  const names = page.locator(
    '.nav-folder-title[data-path="Projects/Notes"] + .tree-item-children .nav-file-title',
  );
  await expect(names).toHaveText(['Dynamics', 'Kinematics']);
});

test('renaming a note rewrites links to it across the vault', async () => {
  await page.waitForFunction(() => window.app?.metadataCache.isResolved());
  await fileTitle(page, 'Welcome.md').click();
  await page.locator('.view-header-title').click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('Home');
  await page.keyboard.press('Enter');
  await expect(fileTitle(page, 'Home.md')).toBeVisible();

  await folderTitle(page, 'Projects').click();
  await fileTitle(page, 'Projects/Robot arm.md').click({ button: 'right' });
  await menuItem('Rename...').click();
  await page.keyboard.type('Manipulator');
  await page.keyboard.press('Enter');
  await expect(fileTitle(page, 'Projects/Manipulator.md')).toBeVisible();

  await expect.poll(() => fs.readFile(path.join(vaultDir, 'Home.md'), 'utf8')).toContain('[[Manipulator]]');
  expect(await fs.readFile(path.join(vaultDir, 'Showcase.md'), 'utf8')).toContain('[[Manipulator|the arm]]');
});
