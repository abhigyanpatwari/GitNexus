interface Sink {
  put(x: boolean | number): 'first';
  flush(): void;
}
interface Sink { put(x: number | string): 'second' }
export function use(s: Sink, n: number) { return s.put(n); }
export function first(s: Sink, b: boolean) { return s.put(b); }
export function flush(s: Sink) { s.flush(); }

interface Account { open(): void; }
interface Account { close(): void; }
class CloudAccount implements Account {
  open() {}
  close() {}
}
export function openAccount() {
  const account: Account = new CloudAccount();
  account.open();
}
