export class User {
  name: string;
  constructor(name: string) { this.name = name; }
  save(): void {}
}

export function getUsers(): User[] {
  return [new User("alice")];
}
