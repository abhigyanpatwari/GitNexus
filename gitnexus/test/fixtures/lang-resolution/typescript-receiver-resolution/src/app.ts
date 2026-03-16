import { User } from './user';
import { Repo } from './repo';

export function processEntities(): void {
  const user: User = new User();
  const repo: Repo = new Repo();
  user.save();
  repo.save();
}
