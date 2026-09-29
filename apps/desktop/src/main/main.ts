import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from 'electron';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { IPC, type VaultInfo } from '../shared/ipc';
import { isDirectory, VaultRegistry } from './vault-registry';

/*
 * Test and development overrides:
 *   BASALT_USER_DATA  isolates settings (used by the E2E suite)
 *   --vault=<path>    or BASALT_VAULT opens that folder directly
 */
if (process.env.BASALT_USER_DATA) app.setPath('userData', process.env.BASALT_USER_DATA);
app.setName('Basalt');

// Vault files are served to the renderer as app://local/<absolute path>.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

let registry: VaultRegistry;
let mainWindow: BrowserWindow | null = null;

function requestedVault(): string | null {
  const arg = process.argv.find((a) => a.startsWith('--vault='));
  const p = arg ? arg.slice('--vault='.length) : process.env.BASALT_VAULT;
  return p && isDirectory(p) ? path.resolve(p) : null;
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function registerAppProtocol(): void {
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    const vault = registry.current();
    const filePath = path.resolve(decodeURIComponent(url.pathname));
    if (url.host !== 'local' || !vault || !isInside(filePath, vault)) {
      return new Response('Not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(filePath).href);
  });
}

/** File types `openPath` may hand to the OS. Anything else could be an executable. */
const OPENABLE = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'bmp',
  'svg',
  'webp',
  'avif',
  'pdf',
  'mp3',
  'wav',
  'm4a',
  'ogg',
  'flac',
  'webm',
  'mp4',
  'mov',
  'mkv',
  'ogv',
  'txt',
  'csv',
  'json',
]);

function registerIpc(): void {
  ipcMain.handle(IPC.vaultCurrent, () => registry.current());

  ipcMain.handle(IPC.vaultRecent, (): VaultInfo[] =>
    registry.recent().map((v) => ({ path: v.path, name: path.basename(v.path), ts: v.ts })),
  );

  ipcMain.handle(IPC.vaultPick, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const options: Electron.OpenDialogOptions = {
      title: 'Open folder as vault',
      properties: ['openDirectory', 'createDirectory'],
    };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle(IPC.vaultOpen, (event, vaultPath: unknown) => {
    if (typeof vaultPath !== 'string' || !isDirectory(vaultPath)) {
      throw new Error('Folder does not exist.');
    }
    registry.open(vaultPath);
    event.sender.reload();
  });

  ipcMain.handle(IPC.vaultClose, (event) => {
    registry.closeCurrent();
    event.sender.reload();
  });

  ipcMain.handle(IPC.openPath, async (_event, fullPath: unknown) => {
    const vault = registry.current();
    if (typeof fullPath !== 'string' || !vault || !isInside(path.resolve(fullPath), vault)) {
      throw new Error('Refusing to open a path outside the vault.');
    }
    const ext = path.extname(fullPath).slice(1).toLowerCase();
    if (!OPENABLE.has(ext)) throw new Error(`Refusing to open .${ext} files with the system.`);
    const error = await shell.openPath(fullPath);
    if (error) throw new Error(error);
  });

  ipcMain.handle(IPC.trashItem, async (_event, fullPath: unknown) => {
    const vault = registry.current();
    if (typeof fullPath !== 'string' || !vault || !isInside(path.resolve(fullPath), vault)) {
      throw new Error('Refusing to trash a path outside the vault.');
    }
    await shell.trashItem(fullPath);
  });
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 480,
    minHeight: 320,
    show: false,
    backgroundColor: '#18191b',
    title: 'Basalt',
    webPreferences: {
      // Community plugins expect Node and Electron APIs in the renderer (require('fs'),
      // require('electron')). See docs/adr/0002-electron-renderer-node-integration.md.
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      spellcheck: true,
    },
  });
  mainWindow = win;

  // The renderer never navigates; links open in the system browser.
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) {
      event.preventDefault();
      if (/^https?:/i.test(url)) void shell.openExternal(url);
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  void win.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  registry = new VaultRegistry(app.getPath('userData'));
  const requested = requestedVault();
  if (requested) registry.open(requested);

  registerAppProtocol();
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
