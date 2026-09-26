// @vitest-environment happy-dom
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { addIcon, getIcon, getIconIds, installDomHelpers, setIcon } from '../src';

beforeAll(() => installDomHelpers(window as Window & typeof globalThis));

describe('createEl', () => {
  it('applies DomElementInfo and appends to the parent', () => {
    const parent = createDiv();
    const input = parent.createEl('input', {
      cls: ['a', 'b'],
      attr: { 'data-x': 1, hidden: null },
      type: 'text',
      value: 'v',
      placeholder: 'p',
      title: 't',
    });
    expect(parent.firstChild).toBe(input);
    expect(input.className).toBe('a b');
    expect(input.getAttr('data-x')).toBe('1');
    expect([input.type, input.value, input.placeholder, input.title]).toEqual(['text', 'v', 'p', 't']);
  });

  it('accepts a class string, prepend and callback', () => {
    const parent = createDiv();
    parent.createSpan({ text: 'second' });
    const cb = vi.fn();
    const first = parent.createDiv({ cls: 'x y', text: 'first', prepend: true }, cb);
    expect(parent.firstChild).toBe(first);
    expect(first.hasClass('y')).toBe(true);
    expect(cb).toHaveBeenCalledWith(first);
    expect(parent.createDiv('solo').className).toBe('solo');
  });

  it('creates SVG elements in the SVG namespace', () => {
    const svg = createDiv().createSvg('svg', { cls: 'icon', attr: { viewBox: '0 0 1 1' } });
    expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(svg.getAttribute('viewBox')).toBe('0 0 1 1');
  });

  it('supports text as a fragment', () => {
    const frag = createFragment((f) => f.createEl('b', { text: 'bold' }));
    const el = createDiv({ text: frag });
    expect(el.innerHTML).toBe('<b>bold</b>');
  });
});

describe('Node and Element helpers', () => {
  it('empties, detaches and inserts', () => {
    const parent = createDiv();
    const a = parent.createDiv();
    const c = parent.createDiv();
    const b = createDiv();
    parent.insertAfter(b, a);
    expect(parent.indexOf(b)).toBe(1);
    c.detach();
    expect(parent.children).toHaveLength(2);
    parent.empty();
    expect(parent.childNodes).toHaveLength(0);
  });

  it('reorders children in place', () => {
    const parent = createDiv();
    const [a, b, c] = [parent.createDiv(), parent.createDiv(), parent.createDiv()];
    const d = createDiv();
    parent.setChildrenInPlace([c, a, d]);
    expect(Array.from(parent.children)).toEqual([c, a, d]);
    expect(b.parentNode).toBeNull();
  });

  it('manages classes, attributes and visibility', () => {
    const el = createDiv();
    el.addClass('a', 'b');
    el.removeClass('a');
    el.toggleClass(['c', 'd'], true);
    el.toggleClass('b', false);
    expect(el.className).toBe('c d');
    el.setAttrs({ role: 'button', tabindex: 0 });
    el.setAttr('role', null);
    expect([el.getAttr('role'), el.getAttr('tabindex')]).toEqual([null, '0']);
    el.hide();
    expect(el.style.display).toBe('none');
    el.show();
    expect(el.style.display).toBe('');
    el.setCssProps({ '--x': '1px' });
    expect(el.style.getPropertyValue('--x')).toBe('1px');
  });

  it('finds descendants and matching parents', () => {
    const root = createDiv({ cls: 'root' });
    const inner = root.createDiv({ cls: 'item' }).createSpan({ cls: 'leaf' });
    expect(root.find('.leaf')).toBe(inner);
    expect(root.findAll('div, span')).toHaveLength(2);
    expect(root.findAllSelf('.root')).toEqual([root]);
    expect(inner.matchParent('.item')?.className).toBe('item');
    expect(inner.matchParent('.root', inner.parentElement!)).toBeNull();
  });

  it('delegates events by selector and removes them', () => {
    const root = createDiv();
    document.body.appendChild(root);
    const btn = root.createEl('button', { cls: 'go' }).createSpan();
    const handler = vi.fn();
    root.on('click', '.go', handler);
    btn.click();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]![1]).toBe(btn.parentElement);
    root.off('click', '.go', handler);
    btn.click();
    expect(handler).toHaveBeenCalledTimes(1);
    root.detach();
  });

  it('exposes win/doc and instanceOf', () => {
    const el = createDiv();
    expect(el.doc).toBe(document);
    expect(el.win).toBe(window);
    expect(el.instanceOf(HTMLDivElement)).toBe(true);
    expect(el.instanceOf(HTMLSpanElement)).toBe(false);
  });
});

describe('built-in helpers', () => {
  it('extends Array, String, Math and Object', () => {
    const arr = [1, 2, 2, 3];
    expect([arr.first(), arr.last(), arr.contains(3)]).toEqual([1, 3, true]);
    expect(arr.unique()).toEqual([1, 2, 3]);
    arr.remove(2);
    expect(arr).toEqual([1, 3]);
    expect(Array.combine([[1], [2, 3]])).toEqual([1, 2, 3]);
    expect('a{0}c{1}'.format('b', 'd')).toBe('abcd');
    expect('abc'.contains('b')).toBe(true);
    expect(Math.clamp(5, 0, 3)).toBe(3);
    expect(Object.isEmpty({})).toBe(true);
    expect(String.isString('x') && Number.isNumber(1) && isBoolean(false)).toBe(true);
  });
});

describe('icons', () => {
  it('renders lucide icons with and without the prefix', () => {
    const el = createDiv();
    el.createSpan({ text: 'old' });
    setIcon(el, 'file-text');
    const svg = el.firstElementChild!;
    expect(el.childNodes).toHaveLength(1);
    expect(svg.classList.contains('svg-icon')).toBe(true);
    expect(svg.classList.contains('lucide-file-text')).toBe(true);
    expect(getIcon('lucide-file-text')?.childNodes.length).toBe(svg.childNodes.length);
  });

  it('ignores unknown icons', () => {
    const el = createDiv({ text: 'keep' });
    setIcon(el, 'definitely-not-an-icon');
    expect(el.textContent).toBe('keep');
    expect(getIcon('definitely-not-an-icon')).toBeNull();
  });

  it('registers custom icons', () => {
    addIcon('my-icon', '<circle cx="50" cy="50" r="40"/>');
    const svg = getIcon('my-icon')!;
    expect(svg.getAttribute('viewBox')).toBe('0 0 100 100');
    expect(svg.querySelector('circle')).not.toBeNull();
    expect(getIconIds()).toContain('my-icon');
  });

  it('resolves every canonical lucide name and every advertised id', () => {
    const require = createRequire(import.meta.url);
    const iconsDir = path.join(path.dirname(require.resolve('lucide')), '../esm/icons');
    const canonical = fs
      .readdirSync(iconsDir)
      .filter((f) => f.endsWith('.mjs'))
      .map((f) => f.slice(0, -4));
    expect(canonical.length).toBeGreaterThan(1000);
    const unresolved = [...canonical, ...getIconIds()].filter((id) => getIcon(id) === null);
    expect(unresolved).toEqual([]);
  });
});
