export class City {
  getName(): string {
    return 'city';
  }
}

export class Address {
  city: City;

  save(): void {
    // persist address
  }
}

export class User {
  address: Address;

  getAddress(): Address {
    return this.address;
  }
}

export class UserService {
  getUser(): User {
    return new User();
  }
}
