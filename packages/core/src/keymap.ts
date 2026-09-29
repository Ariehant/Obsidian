/**
 * Keyboard scopes, matching the plugin API's `Scope` and `Keymap`.
 *
 * The keymap holds a stack of scopes; the top one sees each keydown first. When no handler
 * in a scope matches, its parent gets the event. A handler that returns `false` stops the
 * event and prevents the default action.
 */

export type Modifier = 'Mod' | 'Ctrl' | 'Meta' | 'Shift' | 'Alt';

export interface KeymapInfo {
  modifiers: string | null;
  key: string | null;
}

export interface KeymapContext extends KeymapInfo {
  vkey: string;
}

export type KeymapEventListener = (evt: KeyboardEvent, ctx: KeymapContext) => false | any;

export interface KeymapEventHandler extends KeymapInfo {
  scope: Scope;
}

interface Registration extends KeymapEventHandler {
  func: KeymapEventListener;
}

const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** Canonical, sorted modifier string for an event, e.g. `Mod,Shift`. */
function eventModifiers(evt: KeyboardEvent): string {
  const mods: string[] = [];
  const mac = isMac();
  if (mac ? evt.metaKey : evt.ctrlKey) mods.push('Mod');
  if (mac && evt.ctrlKey) mods.push('Ctrl');
  if (!mac && evt.metaKey) mods.push('Meta');
  if (evt.shiftKey) mods.push('Shift');
  if (evt.altKey) mods.push('Alt');
  return mods.sort().join(',');
}

function normalizeModifiers(mods: Modifier[]): string {
  const mac = isMac();
  // `Ctrl` on Windows/Linux and `Meta` on macOS are the same as `Mod`.
  return [...new Set(mods.map((m) => ((!mac && m === 'Ctrl') || (mac && m === 'Meta') ? 'Mod' : m)))]
    .sort()
    .join(',');
}

export class Scope {
  private readonly handlers: Registration[] = [];

  constructor(readonly parent?: Scope) {}

  /**
   * `modifiers: null` matches any modifiers; `key: null` matches any key. Keys compare
   * case-insensitively with `KeyboardEvent.key`.
   */
  register(modifiers: Modifier[] | null, key: string | null, func: KeymapEventListener): KeymapEventHandler {
    const reg: Registration = {
      scope: this,
      modifiers: modifiers === null ? null : normalizeModifiers(modifiers),
      key: key === null ? null : key,
      func,
    };
    this.handlers.push(reg);
    return reg;
  }

  unregister(handler: KeymapEventHandler): void {
    const idx = this.handlers.indexOf(handler as Registration);
    if (idx !== -1) this.handlers.splice(idx, 1);
  }

  /** @internal Returns false when a handler consumed the event. */
  handleKey(evt: KeyboardEvent, ctx: KeymapContext): boolean {
    for (const h of this.handlers.slice().reverse()) {
      if (h.modifiers !== null && h.modifiers !== ctx.modifiers) continue;
      if (h.key !== null && h.key.toLowerCase() !== ctx.vkey.toLowerCase() && h.key !== ctx.key) continue;
      if (h.func(evt, { ...ctx, modifiers: ctx.modifiers, key: ctx.key }) === false) return false;
    }
    return this.parent ? this.parent.handleKey(evt, ctx) : true;
  }
}

export class Keymap {
  private readonly stack: Scope[] = [];
  private detach: (() => void) | null = null;

  constructor(readonly rootScope: Scope = new Scope()) {}

  /** Starts listening on a window. Idempotent per keymap. */
  attach(win: Window): void {
    if (this.detach) return;
    const listener = (evt: KeyboardEvent) => this.onKeyDown(evt);
    win.addEventListener('keydown', listener, true);
    this.detach = () => win.removeEventListener('keydown', listener, true);
  }

  dispose(): void {
    this.detach?.();
    this.detach = null;
  }

  pushScope(scope: Scope): void {
    this.popScope(scope);
    this.stack.push(scope);
  }

  popScope(scope: Scope): void {
    const idx = this.stack.lastIndexOf(scope);
    if (idx !== -1) this.stack.splice(idx, 1);
  }

  /** @internal Dispatches to the top scope. Exposed for tests. */
  onKeyDown(evt: KeyboardEvent): void {
    if (evt.isComposing) return;
    const scope = this.stack[this.stack.length - 1] ?? this.rootScope;
    const ctx: KeymapContext = { modifiers: eventModifiers(evt), key: evt.key, vkey: evt.key };
    if (scope.handleKey(evt, ctx) === false) {
      evt.preventDefault();
      evt.stopPropagation();
    }
  }

  static isModifier(evt: MouseEvent | TouchEvent | KeyboardEvent, modifier: Modifier): boolean {
    const e = evt as KeyboardEvent;
    switch (modifier) {
      case 'Mod':
        return isMac() ? e.metaKey : e.ctrlKey;
      case 'Ctrl':
        return e.ctrlKey;
      case 'Meta':
        return e.metaKey;
      case 'Shift':
        return e.shiftKey;
      case 'Alt':
        return e.altKey;
    }
  }

  /** Whether a click should open in a new leaf: `'tab'` for Mod/middle-click, else false. */
  static isModEvent(evt?: UserEvent | null): 'tab' | 'split' | 'window' | boolean {
    if (!evt) return false;
    const mouse = evt as MouseEvent;
    if (mouse.button === 1) return 'tab';
    if (!Keymap.isModifier(evt as KeyboardEvent, 'Mod')) return false;
    if ((evt as KeyboardEvent).altKey) return (evt as KeyboardEvent).shiftKey ? 'window' : 'split';
    return 'tab';
  }
}

export type UserEvent = MouseEvent | KeyboardEvent | TouchEvent | PointerEvent;
