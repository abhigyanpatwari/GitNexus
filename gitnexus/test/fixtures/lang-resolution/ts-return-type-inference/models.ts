export class User {
  name: string;

  constructor(name: string) {
    this.name = name;
  }

  save(): boolean {
    return true;
  }

  getName(): string {
    return this.name;
  }
}
