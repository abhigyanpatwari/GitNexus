const { memberRequest, arrowRequest } = require('../lib/cjs-member');
exports.loadMember = () => memberRequest('/api/cjs-member');
exports.loadArrow = () => arrowRequest('/api/cjs-arrow');
