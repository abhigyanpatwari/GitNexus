const { User } = require('./user');

class UserService {
  /**
   * @returns {User}
   */
  getUser() {
    return new User();
  }
}

module.exports = { UserService };
