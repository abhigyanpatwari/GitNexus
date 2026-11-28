
export class Key {
  kind = 'key' as const;
  before() {}
  save() {}
}
export class Other { save() {} }
export class Value {
  kind = 'value' as const;
  before() {}
  save() {}
}
