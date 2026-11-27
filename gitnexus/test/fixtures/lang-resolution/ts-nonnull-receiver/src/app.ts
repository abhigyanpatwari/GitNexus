import { User } from './user';
import { Repo } from './repo';
// Non-null assertion on a typed parameter: the receiver text is `user!`.
export function viaNonNull(user: User | null): boolean {
  return user!.save();
}
// Parenthesized receiver: the receiver text is `(repo)`.
export function viaParens(repo: Repo): boolean {
  return (repo).save();
}
