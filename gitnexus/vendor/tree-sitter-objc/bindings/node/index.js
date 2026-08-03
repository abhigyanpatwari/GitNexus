const root = require('path').join(__dirname, '..', '..');

module.exports =
  typeof process.versions.bun === 'string'
    ? require(`../../prebuilds/${process.platform}-${process.arch}/tree-sitter-objc.node`)
    : require('node-gyp-build')(root);

try {
  module.exports.nodeTypeInfo = require('../../src/node-types.json');
} catch (_) {}
