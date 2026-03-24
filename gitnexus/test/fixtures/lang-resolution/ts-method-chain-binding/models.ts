export class City {
  name: string;

  constructor(name: string) {
    this.name = name;
  }

  save(): boolean {
    return true;
  }
}

export class Address {
  city: City;

  constructor(city: City) {
    this.city = city;
  }

  getCity(): City {
    return this.city;
  }
}

export class User {
  address: Address;

  constructor(address: Address) {
    this.address = address;
  }
}
