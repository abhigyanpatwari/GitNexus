export class User {
  save(): void {}
  getName(): string { return ''; }
}
export function getUser(): User {
  return new User();
}
