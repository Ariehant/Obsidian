/**
 * Named-event emitter matching the plugin API's `Events` class.
 *
 * Semantics that plugins depend on:
 * - `on` returns an `EventRef` that can be passed to `offref` or `Component.registerEvent`.
 * - `trigger` snapshots the listener list, so listeners added or removed during dispatch
 *   do not affect the current dispatch.
 * - A throwing listener is logged and does not stop the remaining listeners.
 */

export type EventCallback = (...data: any[]) => unknown;

export interface EventRef {
  /** Emitter this ref belongs to. */
  e: Events;
  name: string;
  fn: EventCallback;
  ctx: unknown;
}

export class Events {
  private _events: Record<string, EventRef[]> = {};

  on(name: string, callback: EventCallback, ctx?: any): EventRef {
    const ref: EventRef = { e: this, name, fn: callback, ctx };
    (this._events[name] ??= []).push(ref);
    return ref;
  }

  off(name: string, callback: EventCallback): void {
    const list = this._events[name];
    if (!list) return;
    const remaining = list.filter((ref) => ref.fn !== callback);
    if (remaining.length) this._events[name] = remaining;
    else delete this._events[name];
  }

  offref(ref: EventRef): void {
    const list = this._events[ref.name];
    if (!list) return;
    const idx = list.indexOf(ref);
    if (idx === -1) return;
    list.splice(idx, 1);
    if (!list.length) delete this._events[ref.name];
  }

  trigger(name: string, ...data: unknown[]): void {
    const list = this._events[name];
    if (!list) return;
    for (const ref of list.slice()) this.tryTrigger(ref, data);
  }

  tryTrigger(evt: EventRef, args: unknown[]): void {
    try {
      evt.fn.apply(evt.ctx, args);
    } catch (err) {
      console.error(err);
    }
  }
}
