import { User } from './user';
import { Repo } from './repo';

interface Saveable {
  save(): boolean;
}

export function saveUser() {
  const user = new User() satisfies Saveable;
  user.save();
}

export function saveRepo() {
  const repo = (new Repo());
  repo.save();
}
