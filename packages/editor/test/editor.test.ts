// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { countWords, createEditorState, EditorView } from '../src';

describe('createEditorState', () => {
  it('reports document changes made through a view', () => {
    const onChange = vi.fn();
    const view = new EditorView({ state: createEditorState({ doc: '# Title', onChange }) });
    view.dispatch({ changes: { from: 7, insert: '!' } });
    expect(onChange).toHaveBeenCalledWith('# Title!');
    view.dispatch({ selection: { anchor: 0 } });
    expect(onChange).toHaveBeenCalledTimes(1);
    view.destroy();
  });
});

describe('countWords', () => {
  it.each([
    ['', 0],
    ['one two  three', 3],
    ["don't stop-now", 2],
    ['# Heading\n\n- item *one*', 3],
    ['日本語 text', 4],
  ])('countWords(%j) = %d', (text, n) => {
    expect(countWords(text)).toBe(n);
  });
});
