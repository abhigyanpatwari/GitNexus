function calc\u0075late() { return 7; }
function invoke(c\u0062) { return c\u0062(); }
export function run() { const c\u0062 = calc\u0075late; const next = cb; return next(); }
export function throughParameter() { return invoke(calc\u0075late); }
