import { Address } from './address';

export class User {
  name: string;
  address: Address;

  save(): void {
    // persist user
  }
}
