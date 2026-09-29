import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export const ROOT = path.resolve(__dirname, '../../../..');
const FIXTURE = path.join(ROOT, 'fixtures/vaults/basic');

export interface Session {
  tmp: string;
  vaultDir: string;
  app: ElectronApplication;
  page: Page;
  errors: string[];
}

/** Copies the basic fixture vault to a temp folder. */
export async function makeVault(): Promise<{ tmp: string; vaultDir: string }> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'basalt-e2e-'));
  const vaultDir = path.join(tmp, 'vault');
  await fs.cp(FIXTURE, vaultDir, { recursive: true });
  return { tmp, vaultDir };
}

export async function launch(
  tmp: string,
  env: Record<string, string> = {},
): Promise<{ app: ElectronApplication; page: Page; errors: string[] }> {
  const app = await electron.launch({
    args: [path.join(ROOT, 'apps/desktop'), '--no-sandbox'],
    env: { ...process.env, BASALT_USER_DATA: path.join(tmp, 'user-data'), ...env } as Record<string, string>,
  });
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on('pageerror', (err) => {
    errors.push(err.message);
    console.error('renderer error:', err);
  });
  return { app, page, errors };
}

export const fileTitle = (page: Page, p: string) => page.locator(`.nav-file-title[data-path="${p}"]`);
export const folderTitle = (page: Page, p: string) => page.locator(`.nav-folder-title[data-path="${p}"]`);
export const editorContent = (page: Page) => page.locator('.markdown-source-view .cm-content');
