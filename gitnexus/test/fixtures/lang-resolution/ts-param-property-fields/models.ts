export class Address {
  city: string;

  save(): void {
    // persist address
  }
}

export class User {
  #secret: string;

  constructor(
    public name: string,
    public address: Address,
  ) {
    this.#secret = 'hidden';
  }

  greet(): string {
    return this.name;
  }
}
