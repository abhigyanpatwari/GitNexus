interface Sink {
  put(x: boolean | number): 'first';
  flush(): void;
}
interface Sink { put(x: number | string): 'second' }
export function use(s: Sink, n: number) { return s.put(n); }
export function first(s: Sink, b: boolean) { return s.put(b); }
export function flush(s: Sink) { s.flush(); }
