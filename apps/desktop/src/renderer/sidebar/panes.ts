import { parseFrontMatterAliases, TFile, type CachedMetadata, type HeadingCache } from '@basalt/core';
import { setIcon } from '@basalt/ui';
import { renderSnippet, SidebarView } from './sidebar-view';

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

// ---------------------------------------------------------------------------------------
// Backlinks

interface Mention {
  file: TFile;
  text: string;
  from: number;
  to: number;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Ranges where a plain-text mention doesn't count (links, code, frontmatter). */
function excludedRanges(cache: CachedMetadata | null): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const r of [...(cache?.links ?? []), ...(cache?.embeds ?? []), ...(cache?.tags ?? [])]) {
    out.push([r.position.start.offset, r.position.end.offset]);
  }
  for (const s of cache?.sections ?? []) {
    if (s.type === 'code' || s.type === 'yaml') out.push([s.position.start.offset, s.position.end.offset]);
  }
  if (cache?.frontmatterPosition) {
    out.push([cache.frontmatterPosition.start.offset, cache.frontmatterPosition.end.offset]);
  }
  return out;
}

export class BacklinksView extends SidebarView {
  readonly type = 'backlink';
  readonly title = 'Backlinks';
  readonly icon = 'links-coming-in';

  protected async render(): Promise<void> {
    const file = this.ctx.activeFile();
    if (!file) return this.emptyState('No file is open.');
    const { metadataCache: cache, vault } = this.ctx.app;
    const backlinks = cache.getBacklinksForFile(file);

    const sources = [...backlinks.keys()]
      .map((p) => vault.getFileByPath(p))
      .filter((f): f is TFile => !!f)
      .sort((a, b) => byName.compare(a.basename, b.basename));
    const texts = await Promise.all(sources.map((s) => vault.cachedRead(s)));
    if (file !== this.ctx.activeFile()) return;

    this.contentEl.empty();
    const pane = this.contentEl.createDiv('backlink-pane');
    const total = sources.reduce((n, s) => n + backlinks.get(s.path)!.length, 0);
    const linked = this.section(pane, 'Linked mentions', total, false);
    if (!sources.length) linked.createDiv({ cls: 'search-empty-state', text: 'No backlinks found.' });
    sources.forEach((source, i) => {
      const refs = backlinks.get(source.path)!;
      const mentions = refs.map((r) => ({
        file: source,
        text: texts[i]!,
        from: r.position.start.offset,
        to: r.position.end.offset,
      }));
      this.renderResult(linked, source, mentions, false);
    });

    const unlinkedHeader = this.section(
      pane,
      'Unlinked mentions',
      0,
      true,
      (el) => void this.renderUnlinked(file, el),
    );
    unlinkedHeader.parentElement?.querySelector('.tree-item-flair')?.setText('');
  }

  private renderResult(parent: HTMLElement, source: TFile, mentions: Mention[], linkable: boolean): void {
    const result = parent.createDiv('tree-item search-result');
    const title = result.createDiv('tree-item-self search-result-file-title is-clickable');
    title.createDiv({ cls: 'tree-item-inner', text: source.basename, attr: { title: source.path } });
    title
      .createDiv('tree-item-flair-outer')
      .createSpan({ cls: 'tree-item-flair', text: String(mentions.length) });
    title.addEventListener('click', () => this.ctx.openFile(source));
    const matches = result.createDiv('search-result-file-matches');
    for (const m of mentions) {
      const row = matches.createDiv('search-result-file-match tappable');
      renderSnippet(row, m.text, m.from, m.to);
      row.addEventListener('click', () => this.ctx.openFile(m.file, m.from, m.to));
      if (linkable) {
        const button = row.createEl('button', { cls: 'search-result-hover-button mod-cta', text: 'Link' });
        button.addEventListener('click', (ev) => {
          ev.stopPropagation();
          void this.linkMention(m);
        });
      }
    }
  }

  private async renderUnlinked(file: TFile, el: HTMLElement): Promise<void> {
    const { metadataCache: cache, vault } = this.ctx.app;
    const names = [file.basename, ...(parseFrontMatterAliases(cache.getFileCache(file)?.frontmatter) ?? [])];
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}_])(?:${names.map(escapeRegExp).join('|')})(?![\\p{L}\\p{N}_])`,
      'giu',
    );
    let count = 0;
    for (const source of vault.getMarkdownFiles().sort((a, b) => byName.compare(a.basename, b.basename))) {
      if (source === file) continue;
      const text = await vault.cachedRead(source);
      const excluded = excludedRanges(cache.getFileCache(source));
      const mentions: Mention[] = [];
      for (const m of text.matchAll(pattern)) {
        const from = m.index!;
        const to = from + m[0].length;
        if (excluded.some(([a, b]) => from < b && to > a)) continue;
        mentions.push({ file: source, text, from, to });
      }
      if (!mentions.length) continue;
      count += mentions.length;
      this.renderResult(el, source, mentions, true);
    }
    if (!count) el.createDiv({ cls: 'search-empty-state', text: 'No unlinked mentions found.' });
    el.parentElement?.querySelector('.tree-item-flair')?.setText(String(count));
  }

  /** Turns a plain-text mention into a link to the active note. */
  private async linkMention(m: Mention): Promise<void> {
    const target = this.ctx.activeFile();
    if (!target) return;
    const { vault, fileManager } = this.ctx.app;
    const matched = m.text.slice(m.from, m.to);
    await vault.process(m.file, (text) => {
      if (text.slice(m.from, m.to) !== matched) return text; // Changed since; leave it.
      const alias = matched === target.basename ? '' : matched;
      return (
        text.slice(0, m.from) +
        fileManager.generateMarkdownLink(target, m.file.path, '', alias) +
        text.slice(m.to)
      );
    });
  }
}

// ---------------------------------------------------------------------------------------
// Outgoing links

export class OutgoingLinksView extends SidebarView {
  readonly type = 'outgoing-link';
  readonly title = 'Outgoing links';
  readonly icon = 'links-going-out';

  protected render(): void {
    const file = this.ctx.activeFile();
    if (!file) return this.emptyState('No file is open.');
    const cache = this.ctx.app.metadataCache;
    const meta = cache.getFileCache(file);
    const refs = [...(meta?.links ?? []), ...(meta?.embeds ?? []), ...(meta?.frontmatterLinks ?? [])];

    const resolved = new Map<TFile, number>();
    const unresolved = new Map<string, number>();
    for (const ref of refs) {
      const lp = ref.link.split('#')[0]!.trim();
      if (!lp) continue;
      const dest = cache.getFirstLinkpathDest(lp, file.path);
      if (dest) resolved.set(dest, (resolved.get(dest) ?? 0) + 1);
      else unresolved.set(lp, (unresolved.get(lp) ?? 0) + 1);
    }

    this.contentEl.empty();
    const pane = this.contentEl.createDiv('outgoing-link-pane');
    const links = this.section(pane, 'Links', resolved.size + unresolved.size, false);
    if (!resolved.size && !unresolved.size)
      links.createDiv({ cls: 'search-empty-state', text: 'No links found.' });
    for (const [dest, n] of [...resolved].sort((a, b) => byName.compare(a[0].basename, b[0].basename))) {
      const row = this.row(links, dest.extension === 'md' ? dest.basename : dest.name, n, dest.path);
      row.addEventListener('click', () => this.ctx.openFile(dest));
    }
    for (const [lp, n] of [...unresolved].sort((a, b) => byName.compare(a[0], b[0]))) {
      const row = this.row(links, lp, n, 'Not created yet');
      row.addClass('is-unresolved');
      row.addEventListener('click', () => this.ctx.openLink(lp, file.path));
    }
  }

  private row(parent: HTMLElement, text: string, count: number, tooltip: string): HTMLElement {
    const self = parent
      .createDiv('tree-item search-result')
      .createDiv('tree-item-self search-result-file-title is-clickable');
    self.createDiv({ cls: 'tree-item-inner', text, attr: { title: tooltip } });
    self.createDiv('tree-item-flair-outer').createSpan({ cls: 'tree-item-flair', text: String(count) });
    return self;
  }
}

// ---------------------------------------------------------------------------------------
// Outline

export class OutlineView extends SidebarView {
  readonly type = 'outline';
  readonly title = 'Outline';
  readonly icon = 'list';

  protected render(): void {
    const file = this.ctx.activeFile();
    if (!file) return this.emptyState('No file is open.');
    const headings = this.ctx.app.metadataCache.getFileCache(file)?.headings ?? [];
    this.contentEl.empty();
    if (!headings.length) return this.emptyState('No headings found.');
    const root = this.contentEl.createDiv('outline');

    // Nest by level: a heading's children are the following deeper headings.
    const stack: Array<{ level: number; el: HTMLElement }> = [{ level: 0, el: root }];
    for (const h of headings) {
      while (stack.length > 1 && stack[stack.length - 1]!.level >= h.level) stack.pop();
      const parent = stack[stack.length - 1]!.el;
      const childrenEl = this.headingItem(parent, h, file);
      stack.push({ level: h.level, el: childrenEl });
    }
    // Only headings with children get a collapse toggle.
    for (const item of root.findAll('.tree-item')) {
      const children = item.querySelector(':scope > .tree-item-children');
      if (!children?.hasChildNodes())
        item.querySelector(':scope > .tree-item-self > .collapse-icon')?.detach();
    }
  }

  private headingItem(parent: HTMLElement, h: HeadingCache, file: TFile): HTMLElement {
    const item = parent.createDiv('tree-item');
    const self = item.createDiv({
      cls: 'tree-item-self is-clickable',
      attr: { 'data-level': String(h.level) },
    });
    const toggle = self.createDiv('tree-item-icon collapse-icon');
    setIcon(toggle, 'chevron-right');
    toggle.addEventListener('click', (ev) => {
      ev.stopPropagation();
      item.toggleClass('is-collapsed', !item.hasClass('is-collapsed'));
    });
    self.createDiv({ cls: 'tree-item-inner', text: h.heading });
    self.addEventListener('click', () => this.ctx.openFile(file, h.position.start.offset));
    return item.createDiv('tree-item-children');
  }
}

// ---------------------------------------------------------------------------------------
// Tags

interface TagNode {
  name: string;
  full: string;
  count: number;
  children: Map<string, TagNode>;
}

export class TagsView extends SidebarView {
  readonly type = 'tag';
  readonly title = 'Tags';
  readonly icon = 'tags';

  protected render(): void {
    const counts = this.ctx.app.metadataCache.getTags();
    this.contentEl.empty();
    if (!Object.keys(counts).length) return this.emptyState('No tags found.');

    // Tags are case-insensitive; the first spelling seen is shown.
    const root: TagNode = { name: '', full: '', count: 0, children: new Map() };
    for (const [tag, count] of Object.entries(counts)) {
      let node = root;
      let full = '';
      for (const part of tag.slice(1).split('/')) {
        full = full ? `${full}/${part}` : part;
        const key = part.toLowerCase();
        let child = node.children.get(key);
        if (!child)
          node.children.set(key, (child = { name: part, full: `#${full}`, count: 0, children: new Map() }));
        child.count += count; // Parents include their nested tags.
        node = child;
      }
    }
    const pane = this.contentEl.createDiv('tag-container');
    this.renderNodes(pane, root);
  }

  private renderNodes(parent: HTMLElement, node: TagNode): void {
    for (const child of [...node.children.values()].sort((a, b) => byName.compare(a.name, b.name))) {
      const item = parent.createDiv('tree-item');
      const self = item.createDiv({
        cls: 'tree-item-self tag-pane-tag is-clickable',
        attr: { 'data-tag': child.full },
      });
      if (child.children.size) {
        const toggle = self.createDiv('tree-item-icon collapse-icon');
        setIcon(toggle, 'chevron-right');
        toggle.addEventListener('click', () =>
          item.toggleClass('is-collapsed', !item.hasClass('is-collapsed')),
        );
      }
      self.createDiv({ cls: 'tree-item-inner tag-pane-tag-text', text: child.name });
      self
        .createDiv('tree-item-flair-outer')
        .createSpan({ cls: 'tree-item-flair tag-pane-tag-count', text: String(child.count) });
      if (child.children.size) this.renderNodes(item.createDiv('tree-item-children'), child);
    }
  }
}
