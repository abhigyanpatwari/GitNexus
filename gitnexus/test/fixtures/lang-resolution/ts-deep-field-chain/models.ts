export class City {
  zipCode: string;

  getName(): string {
    return 'city';
  }
}

export class Address {
  city: City;
  street: string;

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
