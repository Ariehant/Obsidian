/** Dialogs matching the plugin API's `Modal`. */
import { Scope, type App } from '@basalt/core';
import { setIcon } from './icons';

export class Modal {
  app: App;
  scope: Scope;
  containerEl: HTMLElement;
  modalEl: HTMLElement;
  titleEl: HTMLElement;
  contentEl: HTMLElement;
  /** Restore the focus/selection that was active before opening. */
  shouldRestoreSelection = true;
  private closeCallback: (() => any) | null = null;
  private previousFocus: Element | null = null;
  private isOpen = false;

  constructor(app: App) {
    this.app = app;
    this.scope = new Scope();
    this.scope.register([], 'Escape', () => {
      this.close();
      return false;
    });
    this.containerEl = createDiv({ cls: 'modal-container mod-dim' });
    const bg = this.containerEl.createDiv('modal-bg');
    bg.addEventListener('click', () => this.close());
    this.modalEl = this.containerEl.createDiv({
      cls: 'modal',
      attr: { role: 'dialog', 'aria-modal': 'true' },
    });
    const close = this.modalEl.createDiv({ cls: 'modal-close-button', attr: { 'aria-label': 'Close' } });
    setIcon(close, 'x');
    close.addEventListener('click', () => this.close());
    const header = this.modalEl.createDiv('modal-header');
    this.titleEl = header.createDiv('modal-title');
    this.contentEl = this.modalEl.createDiv('modal-content');
  }

  open(): void {
    if (this.isOpen) return;
    this.isOpen = true;
    this.previousFocus = document.activeElement;
    document.body.appendChild(this.containerEl);
    this.app.keymap.pushScope(this.scope);
    this.modalEl.setAttr('tabindex', '-1');
    this.modalEl.focus();
    void this.onOpen();
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.app.keymap.popScope(this.scope);
    this.containerEl.detach();
    this.onClose();
    this.closeCallback?.();
    if (this.shouldRestoreSelection && this.previousFocus instanceof HTMLElement) this.previousFocus.focus();
  }

  onOpen(): Promise<void> | void {}

  onClose(): void {}

  setTitle(title: string): this {
    this.titleEl.setText(title);
    return this;
  }

  setContent(content: string | DocumentFragment): this {
    this.contentEl.setText(content);
    return this;
  }

  setCloseCallback(callback: () => any): this {
    this.closeCallback = callback;
    return this;
  }
}
