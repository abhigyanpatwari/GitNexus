export class User {
  save() {}
  getName() { return ''; }
}

export function getUser() {
  return new User();
}
