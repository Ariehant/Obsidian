/** Runs async tasks one at a time, in submission order. A failing task does not stop later ones. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.catch(() => undefined);
    return result;
  }

  /** Resolves once every task submitted so far has settled. */
  idle(): Promise<void> {
    return this.tail.then(() => undefined);
  }
}
