import { Component, type App, type TFile } from '@basalt/core';
import { setIcon } from '@basalt/ui';

/** What sidebar panes need from the shell. */
export interface PaneContext {
  app: App;
  activeFile(): TFile | null;
  /** Opens a note, optionally selecting a range. */
  openFile(file: TFile, from?: number, to?: number): void;
  /** Follows a link from a note (creates it when unresolved). */
  openLink(linktext: string, sourcePath: string): void;
}

const REFRESH_DEBOUNCE_MS = 120;

/**
 * Base for sidebar panes. Panes re-render on demand, debounced, and only while visible: a
 * hidden pane remembers it is stale and refreshes when shown.
 */
export abstract class SidebarView extends Component {
  abstract readonly type: string;
  abstract readonly title: string;
  abstract readonly icon: string;
  readonly containerEl: HTMLElement;
  protected readonly contentEl: HTMLElement;
  private visible = false;
  private stale = true;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    parentEl: HTMLElement,
    protected readonly ctx: PaneContext,
  ) {
    super();
    this.containerEl = parentEl.createDiv('workspace-leaf-content');
    this.contentEl = this.containerEl.createDiv('view-content');
  }

  override onload(): void {
    this.containerEl.setAttr('data-type', this.type);
    const cache = this.ctx.app.metadataCache;
    this.registerEvent(cache.on('resolved', () => this.requestRefresh()));
    this.registerEvent(
      cache.on('changed', (file: TFile) => {
        if (file === this.ctx.activeFile()) this.requestRefresh();
      }),
    );
    this.register(() => this.timer && clearTimeout(this.timer));
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.containerEl.parentElement?.toggle(visible);
    if (visible && this.stale) this.refreshNow();
  }

  /** Call when the active file changes or the data behind the pane may have. */
  requestRefresh(): void {
    this.stale = true;
    if (!this.visible || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.refreshNow();
    }, REFRESH_DEBOUNCE_MS);
  }

  refreshNow(): void {
    this.stale = false;
    void Promise.resolve(this.render()).catch((err) => console.error(`${this.type} pane failed`, err));
  }

  protected abstract render(): void | Promise<void>;

  protected emptyState(text: string): void {
    this.contentEl.empty();
    this.contentEl.createDiv({ cls: 'pane-empty', text });
  }

  /** A collapsible tree section with a title and count. */
  protected section(
    parent: HTMLElement,
    title: string,
    count: number,
    collapsed: boolean,
    onExpand?: (childrenEl: HTMLElement) => void,
  ): HTMLElement {
    const item = parent.createDiv({ cls: ['tree-item', collapsed ? 'is-collapsed' : ''] });
    const self = item.createDiv('tree-item-self is-clickable');
    setIcon(self.createDiv('tree-item-icon collapse-icon'), 'chevron-right');
    self.createDiv({ cls: 'tree-item-inner', text: title });
    self
      .createDiv({ cls: 'tree-item-flair-outer' })
      .createSpan({ cls: 'tree-item-flair', text: String(count) });
    const children = item.createDiv('tree-item-children');
    let expanded = !collapsed;
    if (expanded) onExpand?.(children);
    self.addEventListener('click', () => {
      expanded = !expanded;
      item.toggleClass('is-collapsed', !expanded);
      if (expanded && !children.hasChildNodes()) onExpand?.(children);
    });
    return children;
  }
}

/** A line of context around [from, to) with the match highlighted. */
export function renderSnippet(parent: HTMLElement, text: string, from: number, to: number): void {
  const lineStart = text.lastIndexOf('\n', from - 1) + 1;
  let lineEnd = text.indexOf('\n', to);
  if (lineEnd === -1) lineEnd = text.length;
  const CONTEXT = 60;
  const start = Math.max(lineStart, from - CONTEXT);
  const end = Math.min(lineEnd, to + CONTEXT);
  parent.appendText((start > lineStart ? '…' : '') + text.slice(start, from).trimStart());
  parent.createSpan({ cls: 'search-result-file-matched-text', text: text.slice(from, to) });
  parent.appendText(text.slice(to, end).trimEnd() + (end < lineEnd ? '…' : ''));
}
