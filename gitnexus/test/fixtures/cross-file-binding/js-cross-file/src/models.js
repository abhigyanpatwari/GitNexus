export class User {
  save() {}
  getName() { return ''; }
}

/** @returns {User} */
export function getUser() {
  return new User();
}
