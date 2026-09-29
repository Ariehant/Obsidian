/** Toast notifications matching the plugin API's `Notice`. */

const DEFAULT_DURATION = 4500;

function container(doc: Document): HTMLElement {
  return (
    doc.body.querySelector<HTMLElement>(':scope > .notice-container') ??
    doc.body.createDiv('notice-container')
  );
}

export class Notice {
  noticeEl: HTMLElement;
  containerEl: HTMLElement;
  messageEl: HTMLElement;
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** `duration` in ms; 0 keeps the notice until clicked. */
  constructor(message: string | DocumentFragment, duration: number = DEFAULT_DURATION) {
    this.containerEl = container(document);
    this.noticeEl = this.containerEl.createDiv({ cls: 'notice', attr: { role: 'status' } });
    this.messageEl = this.noticeEl.createDiv('notice-message');
    this.setMessage(message);
    this.noticeEl.addEventListener('click', () => this.hide());
    if (duration > 0) this.timer = setTimeout(() => this.hide(), duration);
  }

  setMessage(message: string | DocumentFragment): this {
    this.messageEl.setText(message);
    return this;
  }

  hide(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.noticeEl.detach();
    if (!this.containerEl.hasChildNodes()) this.containerEl.detach();
  }
}
