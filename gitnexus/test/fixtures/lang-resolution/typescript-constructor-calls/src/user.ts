export class User {
  name: string;
  constructor(name: string) {
    this.name = name;
  }
  save(): boolean {
    return true;
  }
}
