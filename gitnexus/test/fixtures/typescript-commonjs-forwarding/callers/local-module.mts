const module = { exports: () => 0 };
function inner() { return 2; }
module.exports = function local() { return inner(); };
export {};
