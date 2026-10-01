import type { CachedMetadata, MetadataParser } from '@basalt/core';
import { computeMetadata } from '@basalt/markdown';
import type { ParseRequest, ParseResponse } from './metadata-worker';

/**
 * Metadata parser backed by a pool of workers, falling back to the main thread when
 * workers can't start.
 */
export class WorkerParser implements MetadataParser {
  private readonly workers: Worker[] = [];
  private readonly pending = new Map<
    number,
    { resolve: (c: CachedMetadata) => void; reject: (e: Error) => void }
  >();
  private nextId = 1;
  private nextWorker = 0;

  constructor(url: string, size = Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 2) - 1))) {
    try {
      for (let i = 0; i < size; i++) {
        const worker = new Worker(url);
        worker.onmessage = (event: MessageEvent<ParseResponse>) => this.onMessage(event.data);
        worker.onerror = (event) => console.error('Metadata worker error', event.message);
        this.workers.push(worker);
      }
    } catch (err) {
      console.warn('Metadata workers unavailable; parsing on the main thread', err);
      this.terminate();
    }
  }

  get usesWorkers(): boolean {
    return this.workers.length > 0;
  }

  parse(text: string): Promise<CachedMetadata> {
    if (!this.workers.length) return Promise.resolve(computeMetadata(text));
    const id = this.nextId++;
    const worker = this.workers[this.nextWorker++ % this.workers.length]!;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, text } satisfies ParseRequest);
    });
  }

  terminate(): void {
    for (const w of this.workers) w.terminate();
    this.workers.length = 0;
    for (const p of this.pending.values()) p.reject(new Error('Parser terminated'));
    this.pending.clear();
  }

  private onMessage(msg: ParseResponse): void {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if ('error' in msg) p.reject(new Error(msg.error));
    else p.resolve(msg.cache);
  }
}
