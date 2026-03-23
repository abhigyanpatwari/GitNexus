export class Address {
  city: string = '';
  save(): boolean { return true; }
}

export class User {
  name: string = '';
  address: Address = new Address();
}
