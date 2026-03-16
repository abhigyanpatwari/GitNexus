import { User } from './user';

export function processUser(name: string): void {
  const user = new User(name);
  user.save();
}
