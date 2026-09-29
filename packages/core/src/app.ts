import { Keymap, Scope } from './keymap';
import type { Vault } from './vault';

/**
 * Root object handed to plugins as `this.app` and exposed as the global `app`.
 *
 * Carries the vault and keymap so far. Workspace, metadata cache, file manager, commands and
 * the rest are added as they are implemented; see docs/PLAN.md §2.
 */
export class App {
  vault: Vault;
  /** Root keyboard scope: app-wide shortcuts register here. */
  scope: Scope;
  keymap: Keymap;

  constructor(vault: Vault) {
    this.vault = vault;
    this.scope = new Scope();
    this.keymap = new Keymap(this.scope);
  }
}
