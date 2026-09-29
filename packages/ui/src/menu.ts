/**
 * Context menus matching the plugin API's `Menu` / `MenuItem`.
 *
 * Items are grouped by section (`setSection`); known sections keep a fixed order so core
 * and plugin items land in predictable places, and separators appear between groups.
 * Keyboard: ↑/↓ move, Enter activates, Escape closes.
 */
import { Component } from '@basalt/core';
import { setIcon } from './icons';

export interface MenuPositionDef {
  x: number;
  y: number;
  width?: number;
  overlap?: boolean;
  left?: boolean;
}

/** Section order, following where the app places its own items. */
const SECTION_ORDER = [
  'title',
  'open',
  'action-primary',
  'action',
  'view',
  'info',
  'selection',
  'clipboard',
  'system',
  '',
  'danger',
];

export class MenuItem {
  /** @internal */ readonly dom: HTMLElement;
  /** @internal */ section = '';
  /** @internal */ disabled = false;
  /** @internal */ isLabel = false;
  private readonly iconEl: HTMLElement;
  private readonly titleEl: HTMLElement;
  private checkEl: HTMLElement | null = null;
  private callback: ((evt: MouseEvent | KeyboardEvent) => any) | null = null;

  /** @internal Created by `Menu.addItem`. */
  constructor(private readonly menu: Menu) {
    this.dom = createDiv({ cls: 'menu-item tappable' });
    this.iconEl = this.dom.createDiv('menu-item-icon');
    this.titleEl = this.dom.createDiv('menu-item-title');
    this.dom.addEventListener('mousedown', (e) => e.preventDefault());
    this.dom.addEventListener('click', (e) => this.activate(e));
    this.dom.addEventListener('mouseenter', () => this.menu.select(this));
  }

  setTitle(title: string | DocumentFragment): this {
    this.titleEl.setText(title);
    return this;
  }

  setIcon(icon: string | null): this {
    this.iconEl.empty();
    if (icon) setIcon(this.iconEl, icon);
    return this;
  }

  setChecked(checked: boolean | null): this {
    if (checked === null) {
      this.checkEl?.detach();
      this.checkEl = null;
    } else {
      this.checkEl ??= this.dom.createDiv('menu-item-icon mod-checked');
      this.checkEl.empty();
      if (checked) setIcon(this.checkEl, 'check');
    }
    this.dom.toggleClass('mod-checked', !!checked);
    return this;
  }

  setDisabled(disabled: boolean): this {
    this.disabled = disabled;
    this.dom.toggleClass('is-disabled', disabled);
    return this;
  }

  setWarning(isWarning: boolean): this {
    this.dom.toggleClass('is-warning', isWarning);
    return this;
  }

  setIsLabel(isLabel: boolean): this {
    this.isLabel = isLabel;
    this.dom.toggleClass('is-label', isLabel);
    return this;
  }

  onClick(callback: (evt: MouseEvent | KeyboardEvent) => any): this {
    this.callback = callback;
    return this;
  }

  setSection(section: string): this {
    this.section = section;
    return this;
  }

  /** @internal */
  activate(evt: MouseEvent | KeyboardEvent): void {
    if (this.disabled || this.isLabel) return;
    this.menu.hide();
    this.callback?.(evt);
  }
}

export class MenuSeparator {
  /** @internal */ readonly dom = createDiv('menu-separator');
}

export class Menu extends Component {
  /** @internal */ readonly dom: HTMLElement;
  private readonly entries: Array<MenuItem | MenuSeparator> = [];
  private selected = -1;
  private hideCallbacks: Array<() => any> = [];
  private parentEl: HTMLElement | null = null;
  private shown = false;
  private noIcon = false;

  constructor() {
    super();
    this.dom = createDiv({ cls: 'menu', attr: { role: 'menu', tabindex: '-1' } });
    this.dom.createDiv('menu-scroll');
  }

  setNoIcon(): this {
    this.noIcon = true;
    this.dom.addClass('mod-no-icon');
    return this;
  }

  /** Native menus aren't supported; the in-app menu is always used. */
  setUseNativeMenu(_useNativeMenu: boolean): this {
    return this;
  }

  addItem(cb: (item: MenuItem) => any): this {
    const item = new MenuItem(this);
    cb(item);
    this.entries.push(item);
    return this;
  }

  addSeparator(): this {
    this.entries.push(new MenuSeparator());
    return this;
  }

  setParentElement(el: HTMLElement): this {
    this.parentEl = el;
    return this;
  }

  showAtMouseEvent(evt: MouseEvent): this {
    evt.preventDefault();
    return this.showAtPosition(
      { x: evt.clientX, y: evt.clientY },
      (evt.target as Node | null)?.ownerDocument ?? document,
    );
  }

  showAtPosition(position: MenuPositionDef, doc: Document = document): this {
    if (!this.hasItems()) return this;
    this.build();
    doc.body.appendChild(this.dom);
    this.shown = true;
    this.load();

    const win = doc.defaultView ?? window;
    const rect = this.dom.getBoundingClientRect();
    let x = position.left ? position.x - rect.width : position.x;
    let y = position.y;
    if (x + rect.width > win.innerWidth) x = Math.max(0, win.innerWidth - rect.width - 4);
    if (y + rect.height > win.innerHeight)
      y = Math.max(0, (position.overlap ? win.innerHeight : position.y) - rect.height - 4);
    this.dom.style.left = `${Math.max(0, x)}px`;
    this.dom.style.top = `${Math.max(0, y)}px`;
    if (position.width) this.dom.style.minWidth = `${position.width}px`;
    this.parentEl?.addClass('has-active-menu');

    this.registerDomEvent(
      doc,
      'mousedown',
      (e) => {
        if (!this.dom.contains(e.target as Node)) this.hide();
      },
      true,
    );
    this.registerDomEvent(doc, 'keydown', (e) => this.onKey(e), true);
    this.registerDomEvent(win as unknown as Window, 'blur', () => this.hide());
    this.registerDomEvent(win as unknown as Window, 'resize', () => this.hide());
    this.dom.focus();
    return this;
  }

  hide(): this {
    if (!this.shown) return this;
    this.shown = false;
    this.dom.detach();
    this.parentEl?.removeClass('has-active-menu');
    this.unload();
    const callbacks = this.hideCallbacks;
    this.hideCallbacks = [];
    for (const cb of callbacks) cb();
    return this;
  }

  close(): void {
    this.hide();
  }

  onHide(callback: () => any): void {
    this.hideCallbacks.push(callback);
  }

  /** Creates a menu that opens at the event's position once the current task finishes. */
  static forEvent(evt: PointerEvent | MouseEvent): Menu {
    const menu = new Menu();
    evt.preventDefault();
    queueMicrotask(() => menu.showAtMouseEvent(evt));
    return menu;
  }

  /** @internal */
  select(item: MenuItem): void {
    this.setSelected(this.items().indexOf(item));
  }

  private items(): MenuItem[] {
    return this.orderedEntries().filter((e): e is MenuItem => e instanceof MenuItem);
  }

  private hasItems(): boolean {
    return this.entries.some((e) => e instanceof MenuItem);
  }

  /** Items grouped by section, with separators between groups and no doubled separators. */
  private orderedEntries(): Array<MenuItem | MenuSeparator> {
    const groups = new Map<string, Array<MenuItem | MenuSeparator>>();
    let current = '';
    for (const e of this.entries) {
      if (e instanceof MenuItem) current = e.section;
      const list = groups.get(current) ?? [];
      list.push(e);
      groups.set(current, list);
    }
    const rank = (s: string) => {
      const i = SECTION_ORDER.indexOf(s);
      return i === -1 ? SECTION_ORDER.indexOf('') : i;
    };
    const keys = [...groups.keys()].sort((a, b) => rank(a) - rank(b));
    const out: Array<MenuItem | MenuSeparator> = [];
    for (const key of keys) {
      const group = groups.get(key)!;
      if (out.length && !(out[out.length - 1] instanceof MenuSeparator)) out.push(new MenuSeparator());
      for (const e of group) {
        if (e instanceof MenuSeparator && (!out.length || out[out.length - 1] instanceof MenuSeparator))
          continue;
        out.push(e);
      }
    }
    while (out.length && out[out.length - 1] instanceof MenuSeparator) out.pop();
    return out;
  }

  private build(): void {
    const scroll = this.dom.querySelector<HTMLElement>('.menu-scroll')!;
    scroll.empty();
    for (const e of this.orderedEntries()) scroll.appendChild(e.dom);
    if (this.noIcon) for (const icon of scroll.findAll('.menu-item-icon')) icon.hide();
  }

  private setSelected(idx: number): void {
    const items = this.items();
    items[this.selected]?.dom.removeClass('selected');
    this.selected = idx;
    items[idx]?.dom.addClass('selected');
  }

  private move(delta: number): void {
    const items = this.items();
    if (!items.length) return;
    let idx = this.selected;
    for (let i = 0; i < items.length; i++) {
      idx = (idx + delta + items.length) % items.length;
      if (!items[idx]!.disabled && !items[idx]!.isLabel) break;
    }
    this.setSelected(idx);
  }

  private onKey(evt: KeyboardEvent): void {
    const handled = () => {
      evt.preventDefault();
      evt.stopPropagation();
    };
    if (evt.key === 'Escape') {
      handled();
      this.hide();
    } else if (evt.key === 'ArrowDown') {
      handled();
      this.move(1);
    } else if (evt.key === 'ArrowUp') {
      handled();
      this.move(-1);
    } else if (evt.key === 'Enter') {
      handled();
      this.items()[this.selected]?.activate(evt);
    }
  }
}
