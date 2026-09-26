import { ipcRenderer } from 'electron';
import { IPC, type VaultInfo } from '../shared/ipc';

/** Start screen shown when no vault is open: recent vaults plus "Open folder as vault". */
export async function renderVaultChooser(parent: HTMLElement): Promise<void> {
  const root = parent.createDiv('vault-chooser');
  const card = root.createDiv('vault-chooser-card');
  card.createDiv({ cls: 'vault-chooser-title', text: 'Basalt' });
  card.createDiv({
    cls: 'vault-chooser-subtitle',
    text: 'A vault is a folder of Markdown files. Open an existing folder, including one you already use as a vault, or choose an empty one to start fresh.',
  });

  const errorEl = card.createDiv('vault-chooser-error');
  const open = async (path: string) => {
    try {
      await ipcRenderer.invoke(IPC.vaultOpen, path);
    } catch (err) {
      errorEl.setText(
        err instanceof Error
          ? err.message.replace(/^Error invoking remote method '[^']+': /, '')
          : String(err),
      );
    }
  };

  const recent = (await ipcRenderer.invoke(IPC.vaultRecent)) as VaultInfo[];
  if (recent.length) {
    const list = card.createDiv('vault-chooser-recent');
    for (const vault of recent) {
      const item = list.createDiv({ cls: 'vault-chooser-recent-item', attr: { 'data-path': vault.path } });
      item.createDiv({ cls: 'vault-chooser-recent-name', text: vault.name });
      item.createDiv({ cls: 'vault-chooser-recent-path', text: vault.path });
      item.addEventListener('click', () => void open(vault.path));
    }
  }

  const button = card.createEl('button', { cls: 'mod-cta', text: 'Open folder as vault' });
  button.addEventListener('click', async () => {
    const path = (await ipcRenderer.invoke(IPC.vaultPick)) as string | null;
    if (path) await open(path);
  });
}
