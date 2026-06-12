// Generative-source fixture (#2084 review P1-1): getInput() reads a remote-input
// source internally and RETURNS it. handleGen calls it and sinks the result —
// neither function alone is a finding (the source is inside getInput, the caller
// passes no tainted input), so only sourceToReturn composition catches it.
import { exec } from 'child_process';

declare const req: { body: string };

export function getInput(): string {
  return req.body;
}

export function handleGen(): void {
  const t = getInput();
  exec(t);
}
