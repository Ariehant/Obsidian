import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { HighlightStyle, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { EditorState, type Extension } from '@codemirror/state';
import { drawSelection, dropCursor, EditorView, keymap, rectangularSelection } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

export { EditorState, EditorView };

/**
 * Maps Lezer highlight tags to the token classes themes style (`cm-header-1`, `cm-strong`,
 * `cm-formatting`, …). Emitting classes instead of inline styles keeps all colours in CSS.
 */
export const markdownHighlightStyle = HighlightStyle.define([
  { tag: t.heading1, class: 'cm-header cm-header-1' },
  { tag: t.heading2, class: 'cm-header cm-header-2' },
  { tag: t.heading3, class: 'cm-header cm-header-3' },
  { tag: t.heading4, class: 'cm-header cm-header-4' },
  { tag: t.heading5, class: 'cm-header cm-header-5' },
  { tag: t.heading6, class: 'cm-header cm-header-6' },
  { tag: t.strong, class: 'cm-strong' },
  { tag: t.emphasis, class: 'cm-em' },
  { tag: t.strikethrough, class: 'cm-strikethrough' },
  { tag: t.link, class: 'cm-link' },
  { tag: t.url, class: 'cm-url' },
  { tag: t.quote, class: 'cm-quote' },
  { tag: t.monospace, class: 'cm-inline-code' },
  { tag: t.list, class: 'cm-list-1' },
  { tag: [t.processingInstruction, t.contentSeparator], class: 'cm-formatting' },
  { tag: [t.meta, t.comment], class: 'cm-comment' },
]);

export interface EditorStateOptions {
  doc: string;
  /** Called after every document change with the full text. */
  onChange?: (doc: string) => void;
  extensions?: Extension[];
}

/** Base extension set for the Markdown source editor. */
export function markdownEditorExtensions(onChange?: (doc: string) => void): Extension[] {
  return [
    history(),
    drawSelection(),
    dropCursor(),
    rectangularSelection(),
    EditorState.allowMultipleSelections.of(true),
    indentUnit.of('    '),
    EditorState.tabSize.of(4),
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({ spellcheck: 'true', autocorrect: 'on', autocapitalize: 'on' }),
    markdown({ base: markdownLanguage, addKeymap: true }),
    syntaxHighlighting(markdownHighlightStyle),
    search({ top: true }),
    highlightSelectionMatches(),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) onChange?.(update.state.doc.toString());
    }),
  ];
}

export function createEditorState(options: EditorStateOptions): EditorState {
  return EditorState.create({
    doc: options.doc,
    extensions: [markdownEditorExtensions(options.onChange), options.extensions ?? []],
  });
}

/**
 * Counts words the way a reader would: runs of letters/digits (with inner apostrophes or
 * hyphens) count once, and each CJK character counts as its own word.
 */
export function countWords(text: string): number {
  const cjk = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu);
  const rest = text.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu, ' ');
  const words = rest.match(/[\p{L}\p{N}]+(?:['’\-_][\p{L}\p{N}]+)*/gu);
  return (cjk?.length ?? 0) + (words?.length ?? 0);
}
