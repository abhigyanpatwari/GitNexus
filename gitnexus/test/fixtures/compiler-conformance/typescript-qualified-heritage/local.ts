namespace Models { export class User { save() {} } }
class User { save() {} }
export class Derived extends Models.User { override save() {} }
export function check(value: Derived) { value.save(); }
