// Interprocedural taint fixture (#2084 M4): the SINK side. `runIt` takes a
// parameter and passes it straight into child_process.exec — a param→sink
// (command-injection) summary. The caller lives in source.ts.
import { exec } from 'child_process';

export function runIt(cmd: string): void {
  exec(cmd);
}

// A pass-through helper for the multi-hop case: param→callee-arg of runIt.
export function forward(value: string): void {
  runIt(value);
}
