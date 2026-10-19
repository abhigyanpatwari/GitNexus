const { cjsRequest } = require('../lib/cjs');
exports.loadCjs = () => cjsRequest('/api/cjs');
