import { User } from './user';
import { Repo } from './repo';
// `as` cast on an untyped value: the cast names the receiver's type.
export function viaAs(x: unknown): boolean {
  return (x as User).save();
}
// Angle-bracket assertion.
export function viaAngle(x: unknown): boolean {
  return (<Repo>x).save();
}
// Optional call on a cast receiver.
export function viaOptional(x: unknown): boolean | undefined {
  return (x as User)?.save();
}
// Double cast: the outermost target wins.
export function viaDouble(x: unknown): boolean {
  return ((x as unknown) as Repo).save();
}
// The cast narrows a declared type: the call goes to Repo.save, not User.save.
export function narrowed(u: User): boolean {
  return (u as unknown as Repo).save();
}
// A cast to a type the index cannot find resolves nothing, rather than guessing
// from the declared type of the operand.
export function unresolvedTarget(u: User): boolean {
  return (u as Missing).save();
}
export function typeParameter<T>(u: User): boolean {
  return (u as T).save();
}
