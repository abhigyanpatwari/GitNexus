import { User } from './user';
import { Repo } from './repo';

function process() {
  const user = new User() as any;
  user.save();

  const repo = new Repo()!;
  repo.save();
}
