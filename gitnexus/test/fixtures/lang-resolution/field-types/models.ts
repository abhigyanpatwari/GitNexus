export class Address {
  city: string;

  save(): void {
    // persist address
  }
}

export class User {
  name: string;
  address: Address;

  greet(): string {
    return this.name;
  }
}

export class Config {
  static DEFAULT: Config = new Config();

  validate(): boolean {
    return true;
  }
}
