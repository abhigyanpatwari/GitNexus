import { run } from './target';
export class Receiver {
  static own() { return 1; }
  run() { return 2; }
  use() { run(); this.run(); Receiver.own(); }
}
