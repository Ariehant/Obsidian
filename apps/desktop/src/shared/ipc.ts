/** IPC channel names shared by the main and renderer processes. */
export const IPC = {
  /** () => string | null — vault the window should open, if any. */
  vaultCurrent: 'vault:current',
  /** () => VaultEntry[] */
  vaultRecent: 'vault:recent',
  /** () => string | null — shows a folder picker; resolves to the chosen path. */
  vaultPick: 'vault:pick',
  /** (path) => void — makes the path the current vault and reloads the window. */
  vaultOpen: 'vault:open',
  /** () => void — closes the current vault and reloads into the vault chooser. */
  vaultClose: 'vault:close',
  /** (fullPath) => void — moves a file to the OS trash. */
  trashItem: 'shell:trash-item',
  /** (fullPath) => void — shows a vault file in the system file manager. */
  showItemInFolder: 'shell:show-item-in-folder',
  /** (fullPath) => void — opens a vault file with the system's default app. */
  openPath: 'shell:open-path',
} as const;

export interface VaultInfo {
  path: string;
  name: string;
  ts: number;
}
