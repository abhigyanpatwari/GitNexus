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
// A comment inside the parentheses is not the receiver.
export function viaCommentedParens(user: User): boolean {
  return (/* the user */ user).save();
}
// A trailing comment inside the parentheses, with a non-null assertion.
export function viaTrailingComment(repo: Repo | null): boolean {
  return (repo! /* checked above */).save();
}
