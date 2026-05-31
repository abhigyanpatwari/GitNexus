// export default HOC(arrow) — the pattern used by Nuxt/h3 defineEventHandler,
// Next.js API route handlers, and similar frameworks. There is no const binding,
// so the graph names the wrapped callback from the file/module rather than the
// wrapper helper.
//
// Pre-fix: these were invisible — no variable_declarator ancestor meant no
//          @declaration.function match, so calls inside attributed to File.
// Post-fix: matched by the new export_statement patterns; the file stem is used.

import { doStuff, helper } from './helpers';

// Stand-in for h3/defineEventHandler — same call shape.
const defineEventHandler = <T>(fn: (event: T) => unknown) => fn;

export default defineEventHandler(async (_event) => {
  doStuff(1);
  helper('route');
});
