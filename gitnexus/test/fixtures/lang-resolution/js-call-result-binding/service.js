const { User } = require('./models');

/**
 * @param {string} name
 * @returns {User}
 */
function getUser(name) {
  return new User(name);
}

module.exports = { getUser };
