export {};
var module = { exports: () => 0 };
function inner() { return 2; }
module.exports = function shadowed() { return inner(); };
