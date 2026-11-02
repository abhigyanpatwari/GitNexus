function compute() { return 7; }
function invoke(c\u0062) { return c\u0062(); }
export function run() { const c\u0062 = compute; const next = cb; return next(); }
export function throughParameter() { return invoke(compute); }
