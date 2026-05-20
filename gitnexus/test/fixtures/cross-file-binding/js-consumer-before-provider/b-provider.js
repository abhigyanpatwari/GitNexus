export class User {
  save() {}
}

/** @returns {User} */
export function getUser() {
  return new User();
}
