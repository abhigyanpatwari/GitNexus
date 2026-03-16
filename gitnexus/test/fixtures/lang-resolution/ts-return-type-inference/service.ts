import { User } from './models';

export function getUser(name: string): User {
  return new User(name);
}

export function fetchUserAsync(name: string): Promise<User> {
  return Promise.resolve(new User(name));
}
