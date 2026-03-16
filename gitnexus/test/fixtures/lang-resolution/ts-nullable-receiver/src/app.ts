import { User } from './user';
import { Repo } from './repo';

export function processEntities(): void {
  const user: User | null = new User();
  const repo: Repo | undefined = new Repo();

  // Optional chain calls — receiver should still resolve
  user?.save();
  user?.greet('hello');
  repo?.save();
}
