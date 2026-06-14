// Taint fixture (#2083 M3 U4): one vulnerable source→sink flow and one
// sanitized variant. Lives in its OWN file — sample.ts's line numbers anchor
// pre-existing REACHING_DEF assertions and must not shift.

import { exec } from 'child_process';

// Vulnerable: req.body (remote-input source) flows unsanitized into
// child_process.exec (command-injection sink) → one TAINTED edge.
export function runUserCommand(req: { body: string }): void {
  const cmd = req.body;
  exec(cmd);
}

// Sanitized: encodeURIComponent neutralizes xss before the res.send sink —
// the finding is suppressed and the kill persists as a SANITIZES edge.
export function sendEncoded(req: { query: string }, res: { send(v: string): void }): void {
  const value = encodeURIComponent(req.query);
  res.send(value);
}
