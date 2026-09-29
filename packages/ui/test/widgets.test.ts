// @vitest-environment happy-dom
import { App, Keymap, Scope, Vault, type DataAdapter } from '@basalt/core';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { installDomHelpers, Menu, Modal, Notice } from '../src';

beforeAll(() => installDomHelpers(window as Window & typeof globalThis));
afterEach(() => document.body.empty());

const key = (k: string, init: KeyboardEventInit = {}) =>
  new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });

describe('Keymap and Scope', () => {
  it('dispatches to the top scope, falls back to parents, and stops on false', () => {
    const root = new Scope();
    const keymap = new Keymap(root);
    const rootHit = vi.fn();
    root.register(['Mod'], 's', rootHit);
    const child = new Scope(root);
    const childHit = vi.fn(() => false);
    child.register([], 'Escape', childHit);

    keymap.onKeyDown(key('s', { ctrlKey: true }));
    expect(rootHit).toHaveBeenCalledTimes(1);

    keymap.pushScope(child);
    const esc = key('Escape');
    keymap.onKeyDown(esc);
    expect(childHit).toHaveBeenCalledTimes(1);
    expect(esc.defaultPrevented).toBe(true);
    keymap.onKeyDown(key('S', { ctrlKey: true }));
    expect(rootHit).toHaveBeenCalledTimes(2);

    keymap.popScope(child);
    keymap.onKeyDown(key('Escape'));
    expect(childHit).toHaveBeenCalledTimes(1);
  });

  it('requires exact modifiers unless null', () => {
    const scope = new Scope();
    const keymap = new Keymap(scope);
    const exact = vi.fn();
    const any = vi.fn();
    scope.register(['Mod', 'Shift'], 'n', exact);
    scope.register(null, 'x', any);
    keymap.onKeyDown(key('n', { ctrlKey: true }));
    keymap.onKeyDown(key('N', { ctrlKey: true, shiftKey: true }));
    keymap.onKeyDown(key('x', { altKey: true }));
    expect(exact).toHaveBeenCalledTimes(1);
    expect(any).toHaveBeenCalledTimes(1);
  });

  it('reports modifier clicks for opening in new leaves', () => {
    expect(Keymap.isModEvent(new MouseEvent('click', { ctrlKey: true }))).toBe('tab');
    expect(Keymap.isModEvent(new MouseEvent('click', { button: 1 }))).toBe('tab');
    expect(Keymap.isModEvent(new MouseEvent('click'))).toBe(false);
  });
});

describe('Menu', () => {
  it('orders items by section with separators, and runs the clicked item', () => {
    const del = vi.fn();
    const menu = new Menu()
      .addItem((i) => i.setTitle('Delete').setSection('danger').setWarning(true).onClick(del))
      .addItem((i) => i.setTitle('Rename').setSection('action').setIcon('pencil'))
      .addItem((i) => i.setTitle('Open').setSection('open'));
    const hidden = vi.fn();
    menu.onHide(hidden);
    menu.showAtPosition({ x: 10, y: 10 });

    const rows = Array.from(document.querySelectorAll('.menu .menu-scroll > div')).map((el) =>
      el.classList.contains('menu-separator') ? '---' : el.textContent,
    );
    expect(rows).toEqual(['Open', '---', 'Rename', '---', 'Delete']);
    expect(document.querySelector('.menu-item.is-warning')?.textContent).toBe('Delete');

    document.querySelector<HTMLElement>('.menu-item.is-warning')!.click();
    expect(del).toHaveBeenCalledTimes(1);
    expect(hidden).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.menu')).toBeNull();
  });

  it('navigates with the keyboard and skips disabled items', () => {
    const a = vi.fn();
    const c = vi.fn();
    new Menu()
      .addItem((i) => i.setTitle('A').onClick(a))
      .addItem((i) => i.setTitle('B').setDisabled(true))
      .addItem((i) => i.setTitle('C').onClick(c))
      .showAtPosition({ x: 0, y: 0 });
    document.dispatchEvent(key('ArrowDown'));
    document.dispatchEvent(key('ArrowDown'));
    expect(document.querySelector('.menu-item.selected')?.textContent).toBe('C');
    document.dispatchEvent(key('Enter'));
    expect(c).toHaveBeenCalled();
    expect(a).not.toHaveBeenCalled();
  });

  it('closes on Escape and outside clicks', () => {
    new Menu().addItem((i) => i.setTitle('A')).showAtPosition({ x: 0, y: 0 });
    document.dispatchEvent(key('Escape'));
    expect(document.querySelector('.menu')).toBeNull();

    new Menu().addItem((i) => i.setTitle('A')).showAtPosition({ x: 0, y: 0 });
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(document.querySelector('.menu')).toBeNull();
  });

  it('does not open without items', () => {
    new Menu().showAtPosition({ x: 0, y: 0 });
    expect(document.querySelector('.menu')).toBeNull();
  });
});

describe('Notice', () => {
  it('shows, auto-hides, and hides on click', () => {
    vi.useFakeTimers();
    new Notice('Saved', 1000);
    expect(document.querySelector('.notice-container .notice')?.textContent).toBe('Saved');
    vi.advanceTimersByTime(1000);
    expect(document.querySelector('.notice')).toBeNull();
    expect(document.querySelector('.notice-container')).toBeNull();

    const sticky = new Notice('Stays', 0);
    vi.advanceTimersByTime(60_000);
    expect(sticky.noticeEl.isConnected).toBe(true);
    sticky.noticeEl.click();
    expect(sticky.noticeEl.isConnected).toBe(false);
    vi.useRealTimers();
  });
});

describe('Modal', () => {
  const app = new App(new Vault({ getName: () => 'test' } as unknown as DataAdapter));

  it('opens, closes on Escape through the keymap, and calls hooks', () => {
    const onClose = vi.fn();
    class TestModal extends Modal {
      override onOpen() {
        this.setTitle('Title').setContent('Body');
      }
      override onClose = onClose;
    }
    const m = new TestModal(app);
    const callback = vi.fn();
    m.setCloseCallback(callback);
    m.open();
    expect(document.querySelector('.modal .modal-title')?.textContent).toBe('Title');
    expect(document.querySelector('.modal .modal-content')?.textContent).toBe('Body');

    app.keymap.onKeyDown(key('Escape'));
    expect(document.querySelector('.modal-container')).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('closes on background click', () => {
    const m = new Modal(app);
    m.open();
    document.querySelector<HTMLElement>('.modal-bg')!.click();
    expect(m.containerEl.isConnected).toBe(false);
  });
});
