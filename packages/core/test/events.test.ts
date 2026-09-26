import { describe, expect, it, vi } from 'vitest';
import { Component, Events, normalizePath, splitExtension } from '../src';

describe('Events', () => {
  it('calls listeners with arguments and context', () => {
    const e = new Events();
    const ctx = { hits: 0 };
    e.on(
      'x',
      function (this: typeof ctx, a: unknown, b: unknown) {
        this.hits++;
        expect([a, b]).toEqual([1, 2]);
      },
      ctx,
    );
    e.trigger('x', 1, 2);
    expect(ctx.hits).toBe(1);
  });

  it('removes listeners by callback and by ref', () => {
    const e = new Events();
    const a = vi.fn();
    const b = vi.fn();
    e.on('x', a);
    const ref = e.on('x', b);
    e.off('x', a);
    e.trigger('x');
    e.offref(ref);
    e.trigger('x');
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('snapshots listeners during dispatch', () => {
    const e = new Events();
    const late = vi.fn();
    e.on('x', () => e.on('x', late));
    e.trigger('x');
    expect(late).not.toHaveBeenCalled();
  });

  it('keeps dispatching after a listener throws', () => {
    const e = new Events();
    const after = vi.fn();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    e.on('x', () => {
      throw new Error('boom');
    });
    e.on('x', after);
    e.trigger('x');
    expect(after).toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
  });
});

describe('Component', () => {
  it('loads children after itself and unloads them before its own cleanup', () => {
    const order: string[] = [];
    class Named extends Component {
      constructor(private label: string) {
        super();
      }
      override onload() {
        order.push(`load ${this.label}`);
        this.register(() => order.push(`cleanup ${this.label}`));
      }
      override onunload() {
        order.push(`unload ${this.label}`);
      }
    }
    const parent = new Named('parent');
    parent.addChild(new Named('child'));
    parent.load();
    parent.unload();
    expect(order).toEqual([
      'load parent',
      'load child',
      'cleanup child',
      'unload child',
      'cleanup parent',
      'unload parent',
    ]);
  });

  it('loads a child added after load immediately', () => {
    const parent = new Component();
    parent.load();
    const child = parent.addChild(new Component());
    expect(Component.isLoaded(child)).toBe(true);
    parent.removeChild(child);
    expect(Component.isLoaded(child)).toBe(false);
  });

  it('detaches registered events on unload', () => {
    const e = new Events();
    const fn = vi.fn();
    const c = new Component();
    c.load();
    c.registerEvent(e.on('x', fn));
    e.trigger('x');
    c.unload();
    e.trigger('x');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('clears registered intervals on unload', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const c = new Component();
    c.load();
    c.registerInterval(setInterval(fn, 10) as unknown as number);
    vi.advanceTimersByTime(25);
    c.unload();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('is idempotent', () => {
    const onload = vi.fn();
    class C extends Component {
      override onload = onload;
    }
    const c = new C();
    c.load();
    c.load();
    c.unload();
    c.unload();
    expect(onload).toHaveBeenCalledTimes(1);
  });
});

describe('paths', () => {
  it.each([
    ['', '/'],
    ['/', '/'],
    ['a//b/', 'a/b'],
    ['\\a\\b', 'a/b'],
    ['/a/b.md', 'a/b.md'],
    ['a\u00A0b', 'a b'],
    ['cafe\u0301', 'caf\u00E9'],
  ])('normalizePath(%j) = %j', (input, expected) => {
    expect(normalizePath(input)).toBe(expected);
  });

  it.each([
    ['note.md', 'note', 'md'],
    ['archive.tar.gz', 'archive.tar', 'gz'],
    ['README', 'README', ''],
    ['.gitignore', '.gitignore', ''],
  ])('splitExtension(%j)', (name, basename, extension) => {
    expect(splitExtension(name)).toEqual({ basename, extension });
  });
});
