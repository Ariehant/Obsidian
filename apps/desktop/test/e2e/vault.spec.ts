import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../../../..');
const FIXTURE = path.join(ROOT, 'fixtures/vaults/basic');

let tmp: string;
let vaultDir: string;
let app: ElectronApplication;
let page: Page;

async function launch(env: Record<string, string> = {}): Promise<void> {
  app = await electron.launch({
    args: [path.join(ROOT, 'apps/desktop'), '--no-sandbox'],
    env: { ...process.env, BASALT_USER_DATA: path.join(tmp, 'user-data'), ...env } as Record<string, string>,
  });
  page = await app.firstWindow();
  page.on('pageerror', (err) => console.error('renderer error:', err));
}

const fileTitle = (p: string) => page.locator(`.nav-file-title[data-path="${p}"]`);
const folderTitle = (p: string) => page.locator(`.nav-folder-title[data-path="${p}"]`);
const editorContent = () => page.locator('.markdown-source-view .cm-content');
const readVaultFile = (p: string) => fs.readFile(path.join(vaultDir, p), 'utf8');

test.beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'basalt-e2e-'));
  vaultDir = path.join(tmp, 'vault');
  await fs.cp(FIXTURE, vaultDir, { recursive: true });
});

test.afterEach(async () => {
  await app?.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

test.describe('with a vault open', () => {
  test.beforeEach(async () => {
    await launch({ BASALT_VAULT: vaultDir });
    await expect(fileTitle('Welcome.md')).toBeVisible();
  });

  test('shows the vault tree without hidden folders', async () => {
    await expect(page).toHaveTitle('vault - Basalt');
    const topLevel = page.locator(
      '.nav-folder.mod-root > .tree-item-children > .tree-item > .tree-item-self',
    );
    await expect(topLevel).toHaveText(['attachments', 'Daily', 'Projects', 'Welcome']);
    await expect(page.locator('[data-path=".obsidian"]')).toHaveCount(0);

    await folderTitle('Projects').click();
    await folderTitle('Projects/Notes').click();
    await expect(fileTitle('Projects/Notes/Kinematics.md')).toBeVisible();
    await folderTitle('attachments').click();
    await expect(fileTitle('attachments/diagram.png').locator('.nav-file-tag')).toHaveText('png');
  });

  test('opens a note, edits it and autosaves to disk', async () => {
    await fileTitle('Welcome.md').click();
    await expect(fileTitle('Welcome.md')).toHaveClass(/is-active/);
    await expect(page.locator('.view-header-title')).toHaveText('Welcome');
    await expect(editorContent()).toContainText('fixture vault used by the end-to-end tests');

    await editorContent().click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type('\nTyped in Phase 0.');
    await expect(page.locator('.plugin-word-count')).toContainText('words');

    await expect.poll(() => readVaultFile('Welcome.md'), { timeout: 6000 }).toContain('Typed in Phase 0.');
  });

  test('saves pending edits immediately when switching notes', async () => {
    await fileTitle('Welcome.md').click();
    await editorContent().click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type(' switch');
    await folderTitle('Daily').click();
    await fileTitle('Daily/2026-09-26.md').click();
    await expect(page.locator('.view-header-title')).toHaveText('2026-09-26');
    expect(await readVaultFile('Welcome.md')).toContain(' switch');
  });

  test('reloads the open note when it changes on disk', async () => {
    await fileTitle('Welcome.md').click();
    await fs.writeFile(path.join(vaultDir, 'Welcome.md'), '# Changed outside\n');
    await expect(editorContent()).toHaveText('# Changed outside');
  });

  test('shows files created and deleted outside the app', async () => {
    await fs.writeFile(path.join(vaultDir, 'External.md'), 'hi');
    await expect(fileTitle('External.md')).toBeVisible();
    await fs.rm(path.join(vaultDir, 'External.md'));
    await expect(fileTitle('External.md')).toHaveCount(0);
  });

  test('creates a note and renames it from the title', async () => {
    await page.locator('.nav-action-button[aria-label="New note"]').click();
    await expect(fileTitle('Untitled.md')).toHaveClass(/is-active/);
    await expect(page.locator('.view-header-title')).toBeFocused();
    await page.keyboard.type('Motor controller');
    await page.keyboard.press('Enter');

    await expect(fileTitle('Motor controller.md')).toBeVisible();
    await expect(fileTitle('Untitled.md')).toHaveCount(0);
    await expect(editorContent()).toBeFocused();
    await page.keyboard.type('PID loop');
    await expect.poll(() => readVaultFile('Motor controller.md'), { timeout: 6000 }).toBe('PID loop');
  });

  test('creates a folder and renames it inline', async () => {
    await page.locator('.nav-action-button[aria-label="New folder"]').click();
    const inner = folderTitle('Untitled').locator('.tree-item-inner');
    await expect(inner).toBeFocused();
    await page.keyboard.type('Sensors');
    await page.keyboard.press('Enter');
    await expect(folderTitle('Sensors')).toBeVisible();
    expect((await fs.stat(path.join(vaultDir, 'Sensors'))).isDirectory()).toBe(true);
  });

  test('exposes the plugin-API globals in the renderer', async () => {
    const result = await page.evaluate(() => {
      const el = createDiv({ cls: 'probe', text: 'x' });
      el.addClass('more');
      return {
        className: el.className,
        hasVault: typeof window.app?.vault.getMarkdownFiles === 'function',
        markdownFiles: window.app?.vault.getMarkdownFiles().length,
        nodeRequire: typeof require === 'function' && typeof require('fs').readFileSync === 'function',
      };
    });
    expect(result).toEqual({ className: 'probe more', hasVault: true, markdownFiles: 4, nodeRequire: true });
  });
});

test('shows the vault chooser when no vault is open', async () => {
  await launch();
  await expect(page.locator('.vault-chooser')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open folder as vault' })).toBeVisible();
});

test('remembers the last vault and lists it in the chooser', async () => {
  await launch({ BASALT_VAULT: vaultDir });
  await expect(fileTitle('Welcome.md')).toBeVisible();
  await page.locator('.side-dock-ribbon-action[aria-label="Open another vault"]').click();
  await expect(page.locator('.vault-chooser-recent-item')).toHaveAttribute('data-path', vaultDir);

  await page.locator('.vault-chooser-recent-item').click();
  await expect(fileTitle('Welcome.md')).toBeVisible();
  await app.close();

  await launch();
  await expect(fileTitle('Welcome.md')).toBeVisible();
});
