/** Single-consumer channel; closing it never discards already committed work. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private waiting?: (result: IteratorResult<T>) => void;
  private closed = false;
  push(value: T): void {
    if (this.closed) throw new Error("Stream already closed");
    if (this.waiting) { const waiting = this.waiting; this.waiting = undefined; waiting({ value, done: false }); }
    else this.values.push(value);
  }
  close(): void {
    this.closed = true;
    this.waiting?.({ value: undefined, done: true });
    this.waiting = undefined;
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.values.length) return Promise.resolve({ value: this.values.shift()!, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise(resolve => { this.waiting = resolve; });
      },
      return: async () => { this.close(); return { value: undefined, done: true }; },
    };
  }
}
