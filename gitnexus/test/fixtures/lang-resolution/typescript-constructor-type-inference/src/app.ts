import { User } from './user';
import { Repo } from './repo';

export function processEntities(): void {
  const user = new User('alice');
  const repo = new Repo('/tmp/repo');
  user.save();
  repo.save();
}
