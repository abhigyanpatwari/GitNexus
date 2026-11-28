let { run: changed, stable } = require('./source');
changed = Math.abs;
exports.changed = changed;
exports.stable = stable;

let { run: renamedChanged, stable: renamedStable } = require('./source');
renamedChanged = Math.abs;
exports.renamedChanged = renamedChanged;
exports.renamedStable = renamedStable;
