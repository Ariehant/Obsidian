import type { App } from '@basalt/core';
import { Modal } from '@basalt/ui';

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmText: string;
  /** Styles the confirm button as destructive. */
  warning?: boolean;
}

/** Yes/no dialog. Resolves true when confirmed; Escape, Cancel and clicking outside resolve false. */
export function confirm(app: App, options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    let result = false;
    const modal = new Modal(app).setTitle(options.title).setContent(options.message);
    modal.modalEl.addClass('mod-confirmation');
    const buttons = modal.modalEl.createDiv('modal-button-container');
    const ok = buttons.createEl('button', {
      text: options.confirmText,
      cls: options.warning ? 'mod-warning' : 'mod-cta',
    });
    const cancel = buttons.createEl('button', { text: 'Cancel', cls: 'mod-cancel' });
    ok.addEventListener('click', () => {
      result = true;
      modal.close();
    });
    cancel.addEventListener('click', () => modal.close());
    modal.setCloseCallback(() => resolve(result));
    modal.open();
    ok.focus();
  });
}
