// Taint acceptance battery (#2083 M3 U7): the plan's six fixture shapes not
// already covered by vuln.ts (which carries the reassignment source→sink flow
// and the must-def sanitized variant). Lives in its OWN file — sample.ts's
// line numbers anchor pre-existing REACHING_DEF assertions and must not
// shift, and vuln.ts's lines anchor the U6 explain-tool assertions.
//
// The taint-snapshot test hand-builds this file's import list (test/helpers/
// taint-fixture.ts) — keep the imports below in sync with FIXTURE_IMPORTS.

import { exec } from 'child_process';

// Direct source→sink, statement-local rule (b): req.body lands in the exec
// argument with no def anywhere on the statement → single-hop finding.
export function directSourceToSink(req: { body: string }): void {
  exec(req.body);
}

// Multi-hop chain (3+ hops): the taint walks a → b → c → sink.
export function multiHopChain(req: { body: string }): void {
  const a = req.body;
  const b = a;
  const c = b;
  exec(c);
}

// Conditional sanitizer (may-def leg): the encode runs only when !trusted, so
// the unsanitized seed def still reaches the sink → the finding SURVIVES,
// and the sanitizer's own def is killed (one SANITIZES edge, binding `text`).
export function conditionalSanitizer(
  req: { query: string },
  res: { send(v: string): void },
  trusted: boolean,
): void {
  let text = req.query;
  if (!trusted) {
    text = encodeURIComponent(text);
  }
  res.send(text);
}

// Loop-carried taint: `cmd = cmd + part` feeds itself through the back edge —
// the worklist reaches a fixpoint (monotone visited set) and the sink fires.
export function loopCarried(req: { body: string }, parts: string[]): void {
  let cmd = req.body;
  for (const part of parts) {
    cmd = cmd + part;
  }
  exec(cmd);
}

// Through-call (KTD5): `decorate` is unmodeled — taint propagates through to
// its result with the hop marked viaCall (lower-confidence evidence).
export function throughCall(req: { body: string }): void {
  const raw = req.body;
  const built = decorate(raw);
  exec(built);
}

function decorate(s: string): string {
  return 'sh -c ' + s;
}
