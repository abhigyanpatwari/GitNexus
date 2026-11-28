function privateHelper() { return 2; }
exports.run = function run() { return 1; };
exports.stable = function stable() { return privateHelper(); };
module.exports.arrow = () => 3;
