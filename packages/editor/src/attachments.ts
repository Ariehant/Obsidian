/**
 * Pasting or dropping files into the editor saves them as attachments (via the host) and
 * inserts a link for each one. Plain text pastes and drops are left to CodeMirror.
 */
import { EditorView } from '@codemirror/view';
import { editorHost } from './live-preview';

function filesOf(data: DataTransfer | null): File[] {
  return data ? Array.from(data.files) : [];
}

function insert(view: EditorView, pos: number, links: string[]): void {
  if (!links.length) return;
  const text = links.join('\n');
  view.dispatch({ changes: { from: pos, insert: text }, selection: { anchor: pos + text.length } });
  view.focus();
}

export const attachmentHandlers = EditorView.domEventHandlers({
  paste(ev, view) {
    const host = view.state.facet(editorHost);
    const files = filesOf(ev.clipboardData);
    if (!host?.saveAttachments || !files.length) return false;
    ev.preventDefault();
    const { from, to } = view.state.selection.main;
    if (from !== to) view.dispatch({ changes: { from, to } });
    void host.saveAttachments(files).then(
      (links) => insert(view, from, links),
      (err) => console.error('Paste failed', err),
    );
    return true;
  },
  drop(ev, view) {
    const host = view.state.facet(editorHost);
    const files = filesOf(ev.dataTransfer);
    if (!host?.saveAttachments || !files.length) return false;
    ev.preventDefault();
    const pos = view.posAtCoords({ x: ev.clientX, y: ev.clientY }) ?? view.state.selection.main.head;
    void host.saveAttachments(files).then(
      (links) => insert(view, pos, links),
      (err) => console.error('Drop failed', err),
    );
    return true;
  },
});
