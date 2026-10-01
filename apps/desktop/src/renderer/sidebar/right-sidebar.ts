import { Component } from '@basalt/core';
import { setIcon } from '@basalt/ui';
import { BacklinksView, OutgoingLinksView, OutlineView, TagsView } from './panes';
import type { PaneContext, SidebarView } from './sidebar-view';

/** Right sidebar: one tab group with the link, outline and tag panes. */
export class RightSidebar extends Component {
  readonly views: SidebarView[];
  private active: SidebarView;
  private readonly headers = new Map<SidebarView, HTMLElement>();

  constructor(splitEl: HTMLElement, ctx: PaneContext) {
    super();
    const tabs = splitEl.createDiv('workspace-tabs mod-top');
    const header = tabs
      .createDiv('workspace-tab-header-container')
      .createDiv('workspace-tab-header-container-inner');
    const container = tabs.createDiv('workspace-tab-container');
    const leaf = () => container.createDiv('workspace-leaf');
    this.views = [
      new BacklinksView(leaf(), ctx),
      new OutgoingLinksView(leaf(), ctx),
      new TagsView(leaf(), ctx),
      new OutlineView(leaf(), ctx),
    ];
    for (const view of this.views) {
      this.addChild(view);
      const tab = header.createDiv({
        cls: 'workspace-tab-header tappable',
        attr: { 'aria-label': view.title, 'data-type': view.type },
      });
      setIcon(
        tab.createDiv('workspace-tab-header-inner').createDiv('workspace-tab-header-inner-icon'),
        view.icon,
      );
      tab.addEventListener('click', () => this.setActive(view));
      this.headers.set(view, tab);
    }
    this.active = this.views[0]!;
  }

  override onload(): void {
    this.setActive(this.active);
  }

  setActive(view: SidebarView): void {
    this.active = view;
    for (const v of this.views) {
      v.setVisible(v === view);
      this.headers.get(v)!.toggleClass('is-active', v === view);
    }
  }

  /** The active note changed: every pane is now stale. */
  refreshAll(): void {
    for (const v of this.views) v.requestRefresh();
  }
}
