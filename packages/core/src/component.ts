import type { EventRef } from './events';

/**
 * Lifecycle base class matching the plugin API's `Component`.
 *
 * Anything registered through `register*` is torn down on `unload`. Children are loaded
 * after the parent's `onload`, and unloaded before the parent's own cleanup runs.
 */
interface ComponentState {
  loaded: boolean;
  children: Component[];
  cleanups: Array<() => unknown>;
}

// Lifecycle state lives outside the instance so the class's public shape is exactly the
// plugin API's, which keeps it structurally interchangeable with the API typings.
const states = new WeakMap<Component, ComponentState>();

function stateOf(c: Component): ComponentState {
  let s = states.get(c);
  if (!s) states.set(c, (s = { loaded: false, children: [], cleanups: [] }));
  return s;
}

export class Component {
  load(): void {
    const s = stateOf(this);
    if (s.loaded) return;
    s.loaded = true;
    this.onload();
    for (const child of s.children.slice()) child.load();
  }

  onload(): void {}

  unload(): void {
    const s = stateOf(this);
    if (!s.loaded) return;
    s.loaded = false;

    const children = s.children;
    s.children = [];
    for (let i = children.length - 1; i >= 0; i--) children[i]!.unload();

    const cleanups = s.cleanups;
    s.cleanups = [];
    for (let i = cleanups.length - 1; i >= 0; i--) {
      try {
        cleanups[i]!();
      } catch (err) {
        console.error(err);
      }
    }

    this.onunload();
  }

  onunload(): void {}

  addChild<T extends Component>(component: T): T {
    const s = stateOf(this);
    s.children.push(component);
    if (s.loaded) component.load();
    return component;
  }

  removeChild<T extends Component>(component: T): T {
    const children = stateOf(this).children;
    const idx = children.indexOf(component);
    if (idx !== -1) {
      children.splice(idx, 1);
      component.unload();
    }
    return component;
  }

  register(cb: () => any): void {
    stateOf(this).cleanups.push(cb);
  }

  registerEvent(eventRef: EventRef): void {
    this.register(() => eventRef.e.offref(eventRef));
  }

  registerDomEvent<K extends keyof WindowEventMap>(
    el: Window,
    type: K,
    callback: (this: HTMLElement, ev: WindowEventMap[K]) => any,
    options?: boolean | AddEventListenerOptions,
  ): void;
  registerDomEvent<K extends keyof DocumentEventMap>(
    el: Document,
    type: K,
    callback: (this: HTMLElement, ev: DocumentEventMap[K]) => any,
    options?: boolean | AddEventListenerOptions,
  ): void;
  registerDomEvent<K extends keyof HTMLElementEventMap>(
    el: HTMLElement,
    type: K,
    callback: (this: HTMLElement, ev: HTMLElementEventMap[K]) => any,
    options?: boolean | AddEventListenerOptions,
  ): void;
  registerDomEvent(
    el: EventTarget,
    type: string,
    callback: (ev: any) => any,
    options?: boolean | AddEventListenerOptions,
  ): void {
    el.addEventListener(type, callback, options);
    this.register(() => el.removeEventListener(type, callback, options));
  }

  /** @internal Whether `load` has run and `unload` has not. Not part of the plugin API. */
  static isLoaded(component: Component): boolean {
    return states.get(component)?.loaded ?? false;
  }

  registerInterval(id: number): number {
    this.register(() => clearInterval(id));
    return id;
  }
}
