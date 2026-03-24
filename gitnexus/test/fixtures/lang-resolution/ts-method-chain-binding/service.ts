import { User, Address, City } from './models';

export function getUser(): User {
  return new User(new Address(new City('NYC')));
}
