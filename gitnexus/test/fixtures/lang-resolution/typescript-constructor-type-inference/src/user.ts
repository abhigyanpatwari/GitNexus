export class User {
  constructor(private readonly name: string) {}

  save(): boolean {
    return this.name.length > 0;
  }
}
