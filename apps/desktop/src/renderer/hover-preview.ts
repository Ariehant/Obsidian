import { Component, type App, type TFile } from '@basalt/core';
import {
  IMAGE_EXTENSIONS,
  isExternalUrl,
  parseLinktext,
  renderMarkdown,
  resolveSubpath,
  type RenderHost,
} from '@basalt/markdown';

const SHOW_DELAY_MS = 300;
const HIDE_DELAY_MS = 250;
const LINK_SELECTOR = 'a.internal-link, .cm-content [data-href]';

/**
 * Page previews: hovering an internal link shows the target note in a popover. In the
 * reading view and inside previews no modifier is needed; in the editor hold Ctrl/Cmd.
 */
export class HoverPreview extends Component {
  private showTimer: ReturnType<typeof setTimeout> | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private popovers: Array<{ el: HTMLElement; anchor: HTMLElement }> = [];

  constructor(
    private readonly app: App,
    private readonly renderHost: () => RenderHost,
    private readonly activeFile: () => TFile | null,
    private readonly openLink: (linktext: string, sourcePath: string) => void,
  ) {
    super();
  }

  override onload(): void {
    this.registerDomEvent(document, 'mouseover', (ev) => this.onOver(ev));
    this.registerDomEvent(document, 'mouseout', (ev) => this.onOut(ev));
    this.registerDomEvent(document, 'keydown', (ev) => ev.key === 'Escape' && this.hideAll());
    this.registerDomEvent(document, 'mousedown', (ev) => {
      if (!this.popovers.some((p) => p.el.contains(ev.target as Node))) this.hideAll();
    });
    this.register(() => this.hideAll());
  }

  private sourcePathFor(el: HTMLElement): string | null {
    const scoped = el.closest<HTMLElement>('[data-embed-path], [data-source-path]');
    return scoped?.dataset.embedPath ?? scoped?.dataset.sourcePath ?? this.activeFile()?.path ?? null;
  }

  private onOver(ev: MouseEvent): void {
    const target = (ev.target as HTMLElement | null)?.closest<HTMLElement>(LINK_SELECTOR);
    if (!target) {
      if (this.popovers.some((p) => p.el.contains(ev.target as Node))) this.cancelHide();
      return;
    }
    const inEditor = !!target.closest('.cm-content');
    if (inEditor && !(ev.ctrlKey || ev.metaKey)) return;
    const href = target.dataset.href ?? '';
    if (!href || isExternalUrl(href) || this.popovers.some((p) => p.anchor === target)) return;
    this.cancelHide();
    if (this.showTimer) clearTimeout(this.showTimer);
    this.showTimer = setTimeout(() => void this.show(target, href), SHOW_DELAY_MS);
  }

  private onOut(ev: MouseEvent): void {
    const from = ev.target as HTMLElement | null;
    const to = ev.relatedTarget as Node | null;
    if (from?.closest(LINK_SELECTOR) && this.showTimer) {
      clearTimeout(this.showTimer);
      this.showTimer = null;
    }
    const inside = (n: Node | null) =>
      !!n && this.popovers.some((p) => p.el.contains(n) || p.anchor.contains(n));
    if (inside(from) && !inside(to)) this.scheduleHide();
  }

  private cancelHide(): void {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = null;
  }

  private scheduleHide(): void {
    this.cancelHide();
    this.hideTimer = setTimeout(() => this.hideAll(), HIDE_DELAY_MS);
  }

  private hideAll(): void {
    this.cancelHide();
    for (const p of this.popovers) p.el.detach();
    this.popovers = [];
  }

  private async show(anchor: HTMLElement, linktext: string): Promise<void> {
    this.showTimer = null;
    if (!anchor.isConnected) return;
    const sourcePath = this.sourcePathFor(anchor);
    if (sourcePath === null) return;
    const { path, subpath } = parseLinktext(linktext);
    const cache = this.app.metadataCache;
    const file = path
      ? cache.getFirstLinkpathDest(path, sourcePath)
      : this.app.vault.getFileByPath(sourcePath);
    if (!file) return;

    // A link inside a preview opens a nested preview; anything else replaces them.
    const parentIdx = this.popovers.findIndex((p) => p.el.contains(anchor));
    for (const p of this.popovers.splice(parentIdx + 1)) p.el.detach();

    const popover = document.body.createDiv({
      cls: 'popover hover-popover',
      attr: { 'data-source-path': file.path },
    });
    const embed = popover.createDiv({
      cls: 'markdown-embed is-loaded',
      attr: { 'data-embed-path': file.path },
    });
    const content = embed.createDiv('markdown-embed-content');
    const view = content.createDiv('markdown-preview-view markdown-rendered');
    this.popovers.push({ el: popover, anchor });
    this.position(popover, anchor);

    popover.addEventListener('click', (ev) => {
      const link = (ev.target as HTMLElement).closest<HTMLElement>('a.internal-link');
      if (!link) return;
      ev.preventDefault();
      this.hideAll();
      this.openLink(link.dataset.href ?? '', file.path);
    });

    if (IMAGE_EXTENSIONS.has(file.extension.toLowerCase())) {
      view.createEl('img', { attr: { src: this.app.vault.getResourcePath(file), alt: file.basename } });
    } else if (file.extension === 'md') {
      let source = await this.app.vault.cachedRead(file);
      if (subpath) {
        const range = resolveSubpath(source, subpath);
        if (range) source = source.slice(range.from, range.to);
      }
      await renderMarkdown(source, view, { sourcePath: file.path, host: this.renderHost() });
    } else {
      view.createDiv({ cls: 'pane-empty', text: `${file.name}` });
    }
    if (popover.isConnected) this.position(popover, anchor);
  }

  private position(popover: HTMLElement, anchor: HTMLElement): void {
    const rect = anchor.getBoundingClientRect();
    const box = popover.getBoundingClientRect();
    const margin = 8;
    let top = rect.bottom + margin;
    if (top + box.height > window.innerHeight - margin && rect.top - box.height - margin > 0) {
      top = rect.top - box.height - margin;
    }
    const left = Math.min(Math.max(margin, rect.left), window.innerWidth - box.width - margin);
    popover.style.top = `${Math.max(margin, top)}px`;
    popover.style.left = `${Math.max(margin, left)}px`;
  }
}
