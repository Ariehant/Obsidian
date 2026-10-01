// @vitest-environment happy-dom
import { installDomHelpers } from '@basalt/ui';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { inferPropertyType, renderProperties } from '../src/properties';

beforeAll(() => installDomHelpers(window as Window & typeof globalThis));

const FM = {
  tags: ['robotics', 'arm'],
  status: 'draft',
  joints: 6,
  reviewed: false,
  updated: '2026-09-30',
  aliases: 'Arm',
};

describe('inferPropertyType', () => {
  it.each([
    ['tags', ['a'], 'tags'],
    ['aliases', 'x', 'aliases'],
    ['list', ['a'], 'multitext'],
    ['n', 3, 'number'],
    ['b', true, 'checkbox'],
    ['d', '2026-10-01', 'date'],
    ['dt', '2026-10-01T09:30', 'datetime'],
    ['t', 'hello', 'text'],
    ['empty', null, 'text'],
    ['obj', { a: 1 }, 'unknown'],
  ])('%s → %s', (key, value, type) => {
    expect(inferPropertyType(key, value)).toBe(type);
  });
});

describe('renderProperties', () => {
  it('renders read-only rows with typed values', () => {
    const el = renderProperties(document.createElement('div'), FM);
    const types = Array.from(el.querySelectorAll<HTMLElement>('.metadata-property')).map((r) => [
      r.dataset.propertyKey,
      r.dataset.propertyType,
    ]);
    expect(types).toEqual([
      ['tags', 'tags'],
      ['status', 'text'],
      ['joints', 'number'],
      ['reviewed', 'checkbox'],
      ['updated', 'date'],
      ['aliases', 'aliases'],
    ]);
    expect(
      Array.from(el.querySelectorAll('[data-property-key="tags"] .multi-select-pill')).map(
        (p) => p.textContent,
      ),
    ).toEqual(['#robotics', '#arm']);
    expect(el.querySelector('input:not([disabled])')).toBeNull();
  });

  it('reports edits as a full new frontmatter object', () => {
    const onChange = vi.fn();
    const el = renderProperties(document.createElement('div'), FM, { onChange });
    document.body.appendChild(el);

    const status = el.querySelector<HTMLInputElement>('[data-property-key="status"] .metadata-input')!;
    status.value = 'done';
    status.dispatchEvent(new Event('blur'));
    expect(onChange).toHaveBeenLastCalledWith({ ...FM, status: 'done' });

    const box = el.querySelector<HTMLInputElement>('[data-property-key="reviewed"] input[type="checkbox"]')!;
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    expect(onChange).toHaveBeenLastCalledWith({ ...FM, reviewed: true });

    const add = el.querySelector<HTMLInputElement>('[data-property-key="tags"] .multi-select-input')!;
    add.value = '#control';
    add.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(onChange).toHaveBeenLastCalledWith({ ...FM, tags: ['robotics', 'arm', 'control'] });

    el.querySelector<HTMLElement>('[data-property-key="tags"] .multi-select-pill-remove-button')!.click();
    expect(onChange).toHaveBeenLastCalledWith({ ...FM, tags: ['arm'] });

    const key = el.querySelector<HTMLInputElement>(
      '[data-property-key="joints"] .metadata-property-key-input',
    )!;
    key.value = 'dof';
    key.dispatchEvent(new Event('blur'));
    expect(Object.keys(onChange.mock.lastCall![0])).toEqual([
      'tags',
      'status',
      'dof',
      'reviewed',
      'updated',
      'aliases',
    ]);

    el.querySelector<HTMLElement>('[data-property-key="status"] .metadata-property-remove')!.click();
    expect(onChange.mock.lastCall![0]).not.toHaveProperty('status');

    el.querySelector<HTMLElement>('.metadata-add-button')!.click();
    expect(onChange.mock.lastCall![0]).toHaveProperty('property', null);
  });
});
