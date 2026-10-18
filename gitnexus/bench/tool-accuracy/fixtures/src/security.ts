import { execSync } from 'node:child_process';
const SHA_RE = /^[0-9a-f]{7,40}$/;

export function runGit(args: string): string {
  return execSync('git ' + args, { encoding: 'utf8' });
}
export function blameSummary(ref: string): string {
  return runGit('blame ' + ref);
}
export function commitSubject(ref: string): string {
  if (!SHA_RE.test(ref)) throw new Error('invalid sha');
  return runGit('log -1 ' + ref);
}
export function handleUnsafe(req: any): string {
  const ref = req.query.ref as string;
  return blameSummary(ref);
}
export function handleGuarded(req: any): string {
  const ref = req.query.ref as string;
  return commitSubject(ref);
}
export function directUnsafe(req: any): void {
  const command = req.query.command as string;
  execSync(command);
}
export function safeConstant(): void {
  execSync('git --version');
}
