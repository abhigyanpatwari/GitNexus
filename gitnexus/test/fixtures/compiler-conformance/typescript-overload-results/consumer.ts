import { Source } from './source';

function 源(): Source { return new Source(); }

class Consumer {
  format(value: number): void;
  format(value: string): void;
  format(value: number | string): void {}

  choose(value: string[]): void;
  choose(value: string | number): void;
  choose(value: string): void;
  choose(value: string[] | string | number): void {}
}

export function run(source: Source, consumer: Consumer) {
  const first = source.lookup('one');
  const second = 源().lookup(2);
  consumer.format(first);
  consumer.format(second);
  consumer.choose(second);
}
