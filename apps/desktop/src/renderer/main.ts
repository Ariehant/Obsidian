import '@basalt/ui/styles/tokens.css';
import '@basalt/ui/styles/app.css';
import '@basalt/ui/styles/markdown.css';
import { installDomHelpers } from '@basalt/ui';
import { ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc';
import { AppShell } from './app-shell';
import { renderVaultChooser } from './vault-chooser';

declare global {
  interface Window {
    /** The running app, as plugins and the dev console expect. Absent in the vault chooser. */
    app?: import('@basalt/core').App;
  }
}

function applyColorScheme(): void {
  const dark = window.matchMedia('(prefers-color-scheme: dark)');
  const apply = () => {
    document.body.toggleClass('theme-dark', dark.matches);
    document.body.toggleClass('theme-light', !dark.matches);
  };
  apply();
  dark.addEventListener('change', apply);
}

async function boot(): Promise<void> {
  installDomHelpers(window);
  applyColorScheme();

  const vaultPath = (await ipcRenderer.invoke(IPC.vaultCurrent)) as string | null;
  if (!vaultPath) {
    await renderVaultChooser(document.body);
    return;
  }

  const shell = new AppShell(document.body, vaultPath);
  window.app = shell.app;
  shell.load();
}

void boot().catch((err) => {
  console.error(err);
  document.body.setText(`Failed to start: ${err instanceof Error ? err.message : String(err)}`);
});
