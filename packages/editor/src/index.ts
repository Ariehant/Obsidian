import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { commonmarkLanguage, markdown } from '@codemirror/lang-markdown';
import { indentUnit } from '@codemirror/language';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { drawSelection, dropCursor, EditorView, keymap, rectangularSelection } from '@codemirror/view';
import { obsidianExtensions } from '@basalt/markdown';
import { editorHost, linkClickHandler, livePreview, type EditorHost } from './live-preview';
import { attachmentHandlers } from './attachments';
import { obsidianAutocomplete } from './suggest';
import { markdownTokens } from './tokens';

export { EditorState, EditorView };
export { editorHost, livePreview, type EditorHost } from './live-preview';
export { obsidianAutocomplete, type SuggestHost } from './suggest';
export { markdownTokens } from './tokens';

export interface EditorStateOptions {
  doc: string;
  /** Called after every document change with the full text. */
  onChange?: (doc: string) => void;
  /** Link resolution and rendering for the note being edited. */
  host?: EditorHost;
  /** Live Preview (default) or source mode. */
  livePreview?: boolean;
  extensions?: Extension[];
}

/** Holds the mode-specific extensions so the mode can switch without losing state. */
const modeCompartment = new Compartment();

function modeExtensions(live: boolean): Extension {
  return live
    ? livePreview()
    : [linkClickHandler(true), EditorView.editorAttributes.of({ class: 'is-source-mode' })];
}

/** Obsidian-flavoured Markdown for CodeMirror: the same grammar the renderer uses. */
export function obsidianMarkdown(): Extension {
  return markdown({ base: commonmarkLanguage, extensions: obsidianExtensions, addKeymap: true });
}

/** Base extension set for the Markdown editor. */
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
    obsidianMarkdown(),
    markdownTokens,
    obsidianAutocomplete(),
    attachmentHandlers,
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
    extensions: [
      markdownEditorExtensions(options.onChange),
      options.host ? editorHost.of(options.host) : [],
      modeCompartment.of(modeExtensions(options.livePreview ?? true)),
      options.extensions ?? [],
    ],
  });
}

/** Switches between Live Preview and source mode, keeping document, history and selection. */
export function setLivePreview(view: EditorView, live: boolean): void {
  view.dispatch({ effects: modeCompartment.reconfigure(modeExtensions(live)) });
}

export function isLivePreview(state: EditorState): boolean {
  return state
    .facet(EditorView.editorAttributes)
    .some((a) => typeof a === 'object' && a?.class === 'is-live-preview');
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
