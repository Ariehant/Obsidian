import { describe, expect, it } from 'vitest';
import { fuzzySort, prepareFuzzySearch, prepareSimpleSearch } from '../src';

describe('prepareFuzzySearch', () => {
  it('matches characters in order and reports ranges', () => {
    const r = prepareFuzzySearch('rba')('Robot arm');
    expect(r).not.toBeNull();
    expect(r!.matches).toEqual([
      [0, 1],
      [2, 3],
      [6, 7],
    ]);
    expect(prepareFuzzySearch('xyz')('Robot arm')).toBeNull();
    expect(prepareFuzzySearch('')('anything')).toEqual({ score: 0, matches: [] });
  });

  it('ranks prefixes, word starts and consecutive runs first', () => {
    const items = ['Kinematics notes', 'Robot arm', 'Arm dynamics', 'Daily/2026-09-26', 'Farm animals'];
    expect(fuzzySort(items, 'arm', (s) => s).map((r) => r.item)).toEqual([
      'Arm dynamics',
      'Robot arm',
      'Farm animals',
    ]);
    expect(fuzzySort(items, 'kn', (s) => s)[0]!.item).toBe('Kinematics notes');
  });
});

describe('prepareSimpleSearch', () => {
  it('requires every word', () => {
    const search = prepareSimpleSearch('arm robot');
    expect(search('Robot arm')?.matches).toEqual([
      [0, 5],
      [6, 9],
    ]);
    expect(search('Robot leg')).toBeNull();
  });
});
