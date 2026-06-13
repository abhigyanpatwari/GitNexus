// Interprocedural taint fixture (#2084 M4): the SOURCE side. `handle` reads a
// remote-input source (req.body) and passes it into runIt across the file
// boundary — a source→callee-arg summary. The fixpoint composes handle's
// source with runIt's param→sink to yield one cross-function TAINT_PATH edge.
import { runIt, forward } from './sink.js';

export function handle(req: { body: string }): void {
  runIt(req.body);
}

// Multi-hop: handle2 → forward → runIt → exec.
export function handle2(req: { body: string }): void {
  forward(req.body);
}
