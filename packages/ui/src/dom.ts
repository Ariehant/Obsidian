/**
 * Installs the global helpers the plugin API declares in `declare global` (see the
 * `obsidian` typings): prototype methods on Node/Element/HTMLElement, `createEl` & co.,
 * and small utilities on Array/String/Math/Object.
 *
 * Plugins call these on every element they touch, so they must exist in every window
 * (main and popouts) before any plugin code runs. Installing is idempotent per window.
 *
 * Existing native methods are never overwritten (e.g. `Array.prototype.findLastIndex`).
 */
import type {} from 'obsidian';

type Win = Window & typeof globalThis;

const INSTALLED = Symbol.for('basalt.domHelpersInstalled');

function define(target: object, props: object, overwrite = false): void {
  for (const [key, value] of Object.entries(props)) {
    if (!overwrite && key in target) continue;
    Object.defineProperty(target, key, { value, configurable: true, writable: true, enumerable: false });
  }
}

function defineGetters(target: object, getters: Record<string, (this: any) => unknown>): void {
  for (const [key, get] of Object.entries(getters)) {
    if (Object.getOwnPropertyDescriptor(target, key)) continue;
    Object.defineProperty(target, key, { get, configurable: true, enumerable: false });
  }
}

type AttrValue = string | number | boolean | null;

function applyAttr(el: Element, name: string, value: AttrValue): void {
  if (value === null) el.removeAttribute(name);
  else el.setAttribute(name, String(value));
}

function applyClasses(el: Element, cls: string | string[] | undefined): void {
  if (!cls) return;
  const list = Array.isArray(cls) ? cls : cls.split(' ');
  el.classList.add(...list.filter(Boolean));
}

function insertInto(parent: Node | undefined, el: Node, prepend?: boolean): void {
  if (!parent) return;
  if (prepend) parent.insertBefore(el, parent.firstChild);
  else parent.appendChild(el);
}

function applyInfo(el: HTMLElement, info: DomElementInfo): void {
  applyClasses(el, info.cls);
  if (info.text !== undefined) el.setText(info.text);
  if (info.attr) for (const [k, v] of Object.entries(info.attr)) applyAttr(el, k, v);
  if (info.title !== undefined) el.title = info.title;
  if (info.value !== undefined && 'value' in el) (el as HTMLInputElement).value = info.value;
  if (info.type !== undefined && 'type' in el) (el as HTMLInputElement).type = info.type;
  if (info.placeholder !== undefined && 'placeholder' in el) {
    (el as HTMLInputElement).placeholder = info.placeholder;
  }
  if (info.href !== undefined && 'href' in el) (el as HTMLAnchorElement).href = info.href;
}

function makeEl<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  o: DomElementInfo | string | undefined,
  parent: Node | undefined,
  callback?: (el: HTMLElementTagNameMap[K]) => void,
): HTMLElementTagNameMap[K] {
  const info: DomElementInfo = typeof o === 'string' ? { cls: o } : (o ?? {});
  const el = doc.createElement(tag);
  applyInfo(el, info);
  insertInto(info.parent ?? parent, el, info.prepend);
  callback?.(el);
  return el;
}

function makeSvg<K extends keyof SVGElementTagNameMap>(
  doc: Document,
  tag: K,
  o: SvgElementInfo | string | undefined,
  parent: Node | undefined,
  callback?: (el: SVGElementTagNameMap[K]) => void,
): SVGElementTagNameMap[K] {
  const info: SvgElementInfo = typeof o === 'string' ? { cls: o } : (o ?? {});
  const el = doc.createElementNS('http://www.w3.org/2000/svg', tag);
  applyClasses(el, info.cls);
  if (info.attr) for (const [k, v] of Object.entries(info.attr)) applyAttr(el, k, v);
  insertInto(info.parent ?? parent, el, info.prepend);
  callback?.(el);
  return el;
}

function docOf(node: Node): Document {
  return node.nodeType === 9 ? (node as Document) : (node.ownerDocument ?? document);
}

/** Delegated listeners, keyed so `off` can find the wrapper it has to remove. */
interface Delegation {
  selector: string;
  listener: Function;
  options?: boolean | AddEventListenerOptions;
  callback: (ev: Event) => void;
}

function delegatedOn(
  target: HTMLElement | Document,
  type: string,
  selector: string,
  listener: (this: any, ev: Event, delegateTarget: HTMLElement) => any,
  options?: boolean | AddEventListenerOptions,
): void {
  const store = ((target as any)._EVENTS ??= {}) as Record<string, Delegation[]>;
  const callback = (ev: Event) => {
    const origin = ev.target as Element | null;
    if (!origin || typeof origin.closest !== 'function') return;
    const match = origin.closest(selector);
    const root = target.nodeType === 9 ? (target as Document).documentElement : (target as HTMLElement);
    if (match && (match === root || root.contains(match))) listener.call(target, ev, match as HTMLElement);
  };
  (store[type] ??= []).push({ selector, listener, options, callback });
  target.addEventListener(type, callback, options);
}

function delegatedOff(
  target: HTMLElement | Document,
  type: string,
  selector: string,
  listener: Function,
  options?: boolean | AddEventListenerOptions,
): void {
  const list = ((target as any)._EVENTS as Record<string, Delegation[]> | undefined)?.[type];
  if (!list) return;
  const idx = list.findIndex((d) => d.selector === selector && d.listener === listener);
  if (idx === -1) return;
  const [d] = list.splice(idx, 1);
  target.removeEventListener(type, d!.callback, options ?? d!.options);
}

export function installDomHelpers(win: Win): void {
  if ((win as any)[INSTALLED]) return;
  (win as any)[INSTALLED] = true;

  // --- Built-in object helpers -------------------------------------------------------

  define(win.Object, {
    isEmpty(object: Record<string, any>): boolean {
      for (const _ in object) return false;
      return true;
    },
    each<T>(object: Record<string, T>, callback: (value: T, key?: string) => boolean | void, context?: any) {
      for (const key in object) {
        if (
          Object.prototype.hasOwnProperty.call(object, key) &&
          callback.call(context, object[key]!, key) === false
        ) {
          return false;
        }
      }
      return true;
    },
  });

  define(win.Array, {
    combine<T>(arrays: T[][]): T[] {
      return ([] as T[]).concat(...arrays);
    },
  });

  define(win.Array.prototype, {
    first<T>(this: T[]) {
      return this[0];
    },
    last<T>(this: T[]) {
      return this[this.length - 1];
    },
    contains<T>(this: T[], target: T) {
      return this.includes(target);
    },
    remove<T>(this: T[], target: T) {
      for (let i = this.indexOf(target); i !== -1; i = this.indexOf(target)) this.splice(i, 1);
    },
    shuffle<T>(this: T[]) {
      for (let i = this.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [this[i], this[j]] = [this[j]!, this[i]!];
      }
      return this;
    },
    unique<T>(this: T[]) {
      return Array.from(new Set(this));
    },
  });

  define(win.Math, {
    clamp: (value: number, min: number, max: number) => Math.min(Math.max(value, min), max),
    square: (value: number) => value * value,
  });

  define(win.String, { isString: (obj: any): obj is string => typeof obj === 'string' });
  define(win.Number, { isNumber: (obj: any): obj is number => typeof obj === 'number' });

  define(win.String.prototype, {
    contains(this: string, target: string) {
      return this.includes(target);
    },
    format(this: string, ...args: string[]) {
      return this.replace(/{(\d+)}/g, (m, n: string) => args[Number(n)] ?? m);
    },
  });

  // --- Node -----------------------------------------------------------------------------

  const nodeMethods: ThisType<Node> &
    Pick<
      Node,
      | 'detach'
      | 'empty'
      | 'insertAfter'
      | 'indexOf'
      | 'setChildrenInPlace'
      | 'appendText'
      | 'instanceOf'
      | 'createEl'
      | 'createDiv'
      | 'createSpan'
      | 'createSvg'
    > = {
    detach() {
      this.parentNode?.removeChild(this);
    },
    empty() {
      while (this.lastChild) this.removeChild(this.lastChild);
    },
    insertAfter<T extends Node>(node: T, child: Node | null): T {
      this.insertBefore(node, child ? child.nextSibling : this.firstChild);
      return node;
    },
    indexOf(other: Node) {
      return Array.prototype.indexOf.call(this.childNodes, other);
    },
    setChildrenInPlace(children: Node[]) {
      const keep = new Set(children);
      for (const child of Array.from(this.childNodes)) if (!keep.has(child)) this.removeChild(child);
      let cursor = this.firstChild;
      for (const child of children) {
        if (child === cursor) cursor = cursor.nextSibling;
        else this.insertBefore(child, cursor);
      }
    },
    appendText(val: string) {
      this.appendChild(docOf(this).createTextNode(val));
    },
    instanceOf<T>(this: Node, type: { new (): T }): this is T {
      if (this instanceof type) return true;
      // Nodes from another window (popouts) fail `instanceof` against this window's class.
      const other = (this.win as any)?.[type.name];
      return typeof other === 'function' && this instanceof other;
    },
    createEl(tag, o, callback) {
      return makeEl(docOf(this), tag, o, this, callback);
    },
    createDiv(o, callback) {
      return makeEl(docOf(this), 'div', o, this, callback);
    },
    createSpan(o, callback) {
      return makeEl(docOf(this), 'span', o, this, callback);
    },
    createSvg(tag, o, callback) {
      return makeSvg(docOf(this), tag, o, this, callback);
    },
  };
  define(win.Node.prototype, nodeMethods);
  defineGetters(win.Node.prototype, {
    doc(this: Node) {
      return docOf(this);
    },
    win(this: Node) {
      return docOf(this).defaultView ?? win;
    },
    constructorWin() {
      return win;
    },
  });

  // --- Element ---------------------------------------------------------------------------

  const elementMethods: ThisType<Element> &
    Pick<
      Element,
      | 'getText'
      | 'setText'
      | 'addClass'
      | 'addClasses'
      | 'removeClass'
      | 'removeClasses'
      | 'toggleClass'
      | 'hasClass'
      | 'setAttr'
      | 'setAttrs'
      | 'getAttr'
      | 'matchParent'
      | 'getCssPropertyValue'
      | 'isActiveElement'
      | 'find'
      | 'findAll'
      | 'findAllSelf'
    > = {
    getText() {
      return this.textContent ?? '';
    },
    setText(val: string | DocumentFragment) {
      if (typeof val === 'string') {
        this.textContent = val;
      } else {
        this.empty();
        this.appendChild(val);
      }
    },
    addClass(...classes: string[]) {
      this.classList.add(...classes.filter(Boolean));
    },
    addClasses(classes: string[]) {
      this.classList.add(...classes.filter(Boolean));
    },
    removeClass(...classes: string[]) {
      this.classList.remove(...classes);
    },
    removeClasses(classes: string[]) {
      this.classList.remove(...classes);
    },
    toggleClass(classes: string | string[], value: boolean) {
      for (const c of Array.isArray(classes) ? classes : [classes]) this.classList.toggle(c, value);
    },
    hasClass(cls: string) {
      return this.classList.contains(cls);
    },
    setAttr(name: string, value: AttrValue) {
      applyAttr(this, name, value);
    },
    setAttrs(obj: Record<string, AttrValue>) {
      for (const [k, v] of Object.entries(obj)) applyAttr(this, k, v);
    },
    getAttr(name: string) {
      return this.getAttribute(name);
    },
    matchParent(selector: string, lastParent?: Element) {
      if (this.matches(selector)) return this;
      for (let el = this.parentElement; el && el !== lastParent; el = el.parentElement) {
        if (el.matches(selector)) return el;
      }
      return null;
    },
    getCssPropertyValue(property: string, pseudoElement?: string) {
      return (this.win as Win).getComputedStyle(this, pseudoElement).getPropertyValue(property);
    },
    isActiveElement() {
      return this.doc.activeElement === this;
    },
    find(selector: string) {
      return this.querySelector(selector);
    },
    findAll(selector: string) {
      return Array.from(this.querySelectorAll<HTMLElement>(selector));
    },
    findAllSelf(selector: string) {
      const all = Array.from(this.querySelectorAll<HTMLElement>(selector));
      return this.matches(selector) ? [this as HTMLElement, ...all] : all;
    },
  };
  define(win.Element.prototype, elementMethods);

  define(win.DocumentFragment.prototype, {
    find(this: DocumentFragment, selector: string) {
      return this.querySelector(selector);
    },
    findAll(this: DocumentFragment, selector: string) {
      return Array.from(this.querySelectorAll(selector));
    },
  });

  // --- HTMLElement / SVGElement -------------------------------------------------------------

  const styleMethods = {
    setCssStyles(this: HTMLElement | SVGElement, styles: Partial<CSSStyleDeclaration>) {
      Object.assign(this.style, styles);
    },
    setCssProps(this: HTMLElement | SVGElement, props: Record<string, string>) {
      for (const [k, v] of Object.entries(props)) this.style.setProperty(k, v);
    },
  };
  define(win.SVGElement.prototype, styleMethods);

  const htmlMethods: ThisType<HTMLElement> &
    Pick<
      HTMLElement,
      | 'show'
      | 'hide'
      | 'toggle'
      | 'toggleVisibility'
      | 'isShown'
      | 'on'
      | 'off'
      | 'onClickEvent'
      | 'onNodeInserted'
      | 'onWindowMigrated'
      | 'trigger'
    > = {
    show() {
      this.style.display = '';
    },
    hide() {
      this.style.display = 'none';
    },
    toggle(show: boolean) {
      this.style.display = show ? '' : 'none';
    },
    toggleVisibility(visible: boolean) {
      this.style.visibility = visible ? '' : 'hidden';
    },
    isShown() {
      return this.isConnected && this.style.display !== 'none' && this.offsetParent !== null;
    },
    on(type, selector, listener, options) {
      delegatedOn(this, type, selector, listener as any, options);
    },
    off(type, selector, listener, options) {
      delegatedOff(this, type, selector, listener, options);
    },
    onClickEvent(listener, options) {
      this.addEventListener('click', listener, options);
      // Middle-click arrives as `auxclick`, which plugins expect to handle the same way.
      this.addEventListener('auxclick', listener, options);
    },
    onNodeInserted(listener, once) {
      let wasConnected = this.isConnected;
      const observer = new (this.win as Win).MutationObserver(() => {
        const connected = this.isConnected;
        if (connected && !wasConnected) {
          listener();
          if (once) observer.disconnect();
        }
        wasConnected = connected;
      });
      observer.observe(this.doc, { childList: true, subtree: true });
      return () => observer.disconnect();
    },
    onWindowMigrated(listener) {
      let current = this.win;
      return this.onNodeInserted(() => {
        if (this.win !== current) {
          current = this.win;
          listener(current);
        }
      });
    },
    trigger(eventType: string) {
      this.dispatchEvent(new (this.win as Win).Event(eventType));
    },
  };
  define(win.HTMLElement.prototype, { ...styleMethods, ...htmlMethods });
  defineGetters(win.HTMLElement.prototype, {
    innerWidth(this: HTMLElement) {
      const s = (this.win as Win).getComputedStyle(this);
      return this.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight);
    },
    innerHeight(this: HTMLElement) {
      const s = (this.win as Win).getComputedStyle(this);
      return this.clientHeight - parseFloat(s.paddingTop) - parseFloat(s.paddingBottom);
    },
  });

  define(win.Document.prototype, {
    on(
      this: Document,
      type: string,
      selector: string,
      listener: any,
      options?: boolean | AddEventListenerOptions,
    ) {
      delegatedOn(this, type, selector, listener, options);
    },
    off(
      this: Document,
      type: string,
      selector: string,
      listener: any,
      options?: boolean | AddEventListenerOptions,
    ) {
      delegatedOff(this, type, selector, listener, options);
    },
  });

  // --- UIEvent ---------------------------------------------------------------------------

  defineGetters(win.UIEvent.prototype, {
    targetNode(this: UIEvent) {
      const t = this.target as any;
      return t && typeof t.nodeType === 'number' ? (t as Node) : null;
    },
    win(this: UIEvent) {
      return this.view ?? (this.target as Node | null)?.win ?? win;
    },
    doc(this: UIEvent) {
      return (this.win as Win).document;
    },
  });
  define(win.UIEvent.prototype, {
    instanceOf<T>(this: UIEvent, type: { new (...data: any[]): T }) {
      if (this instanceof type) return true;
      const other = (this.win as any)?.[type.name];
      return typeof other === 'function' && this instanceof other;
    },
  });

  // --- Globals ---------------------------------------------------------------------------

  const doc = win.document;
  define(
    win,
    {
      isBoolean: (obj: any): obj is boolean => typeof obj === 'boolean',
      fish: (selector: string) => doc.querySelector<HTMLElement>(selector),
      fishAll: (selector: string) => Array.from(doc.querySelectorAll<HTMLElement>(selector)),
      createEl: <K extends keyof HTMLElementTagNameMap>(
        tag: K,
        o?: DomElementInfo | string,
        cb?: (el: HTMLElementTagNameMap[K]) => void,
      ) => makeEl(doc, tag, o, undefined, cb),
      createDiv: (o?: DomElementInfo | string, cb?: (el: HTMLDivElement) => void) =>
        makeEl(doc, 'div', o, undefined, cb),
      createSpan: (o?: DomElementInfo | string, cb?: (el: HTMLSpanElement) => void) =>
        makeEl(doc, 'span', o, undefined, cb),
      createSvg: <K extends keyof SVGElementTagNameMap>(
        tag: K,
        o?: SvgElementInfo | string,
        cb?: (el: SVGElementTagNameMap[K]) => void,
      ) => makeSvg(doc, tag, o, undefined, cb),
      createFragment: (cb?: (el: DocumentFragment) => void) => {
        const frag = doc.createDocumentFragment();
        cb?.(frag);
        return frag;
      },
      sleep: (ms: number) => new Promise<void>((resolve) => win.setTimeout(resolve, ms)),
      nextFrame: () => new Promise<void>((resolve) => win.requestAnimationFrame(() => resolve())),
      ready: (fn: () => any) => {
        if (doc.readyState === 'loading')
          doc.addEventListener('DOMContentLoaded', () => fn(), { once: true });
        else fn();
      },
      ajax: (options: AjaxOptions) => runAjax(win, options),
      ajaxPromise: (options: AjaxOptions) =>
        new Promise((resolve, reject) =>
          runAjax(win, {
            ...options,
            success: (res, req) => {
              options.success?.(res, req);
              resolve(res);
            },
            error: (err, req) => {
              options.error?.(err, req);
              reject(err);
            },
          }),
        ),
    },
    true,
  );
  // `activeWindow`/`activeDocument` track focus across popouts; the workspace updates them.
  if (!('activeWindow' in win)) {
    (win as any).activeWindow = win;
    (win as any).activeDocument = doc;
  }
}

function runAjax(win: Win, options: AjaxOptions): void {
  const req = options.req ?? new win.XMLHttpRequest();
  req.open(options.method ?? 'GET', options.url, true);
  req.withCredentials = !!options.withCredentials;
  for (const [k, v] of Object.entries(options.headers ?? {})) req.setRequestHeader(k, v);
  req.onload = () => {
    if (req.status >= 200 && req.status < 300) options.success?.(req.response, req);
    else options.error?.(new Error(`HTTP ${req.status}`), req);
  };
  req.onerror = (err) => options.error?.(err, req);
  const data = options.data;
  if (data === undefined) req.send();
  else if (typeof data === 'string' || data instanceof ArrayBuffer) req.send(data);
  else {
    req.setRequestHeader('Content-Type', 'application/json');
    req.send(JSON.stringify(data));
  }
}
