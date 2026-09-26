import type { Vault } from './vault';

/**
 * Root object handed to plugins as `this.app` and exposed as the global `app`.
 *
 * Phase 0 only carries the vault. Workspace, metadata cache, file manager, commands and
 * the rest are added as they are implemented; see docs/PLAN.md §2.
 */
export class App {
  vault: Vault;

  constructor(vault: Vault) {
    this.vault = vault;
  }
}
