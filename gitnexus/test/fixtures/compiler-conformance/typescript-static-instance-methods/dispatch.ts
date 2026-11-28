export class Base {
  static render() { return 1; }
  render() { return 2; }
}

export class Child extends Base {
  override render() { return 3; }
}

export function renderBoth(value: Base) {
  return [Base.render(), value.render()];
}
