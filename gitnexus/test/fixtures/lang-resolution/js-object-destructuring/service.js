const { User } = require('./models');

/**
 * @returns {User}
 */
function getUser() { return new User(); }

module.exports = { getUser };
