export class User {
  save(): void {}
}

export function getUser(): User {
  return new User();
}
