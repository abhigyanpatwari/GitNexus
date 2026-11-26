export class Base {
  run() { return 1; }
}

export default class extends Base {
  override run() { return 2; }
}
