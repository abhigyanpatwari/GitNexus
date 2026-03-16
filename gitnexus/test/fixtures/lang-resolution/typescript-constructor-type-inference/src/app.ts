import { User } from './user';
import { Repo } from './repo';

export function processEntities(): void {
  const user = new User();
  const repo = new Repo();
  user.save();
  repo.save();
}
