import { User } from './user';
import { Repo } from './repo';

export function handleUser(entity: User): void {
  entity.save();
}

export function handleRepo(entity: Repo): void {
  entity.save();
}
