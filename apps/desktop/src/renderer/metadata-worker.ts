/**
 * Web Worker: parses notes into CachedMetadata off the UI thread. Imports the DOM-free
 * metadata module directly so the bundle carries only the grammar and YAML parser.
 */
import { computeMetadata } from '@basalt/markdown/src/metadata';

export interface ParseRequest {
  id: number;
  text: string;
}

export type ParseResponse =
  { id: number; cache: ReturnType<typeof computeMetadata> } | { id: number; error: string };

self.onmessage = (event: MessageEvent<ParseRequest>) => {
  const { id, text } = event.data;
  let response: ParseResponse;
  try {
    response = { id, cache: computeMetadata(text) };
  } catch (err) {
    response = { id, error: err instanceof Error ? err.message : String(err) };
  }
  (self as unknown as Worker).postMessage(response);
};
