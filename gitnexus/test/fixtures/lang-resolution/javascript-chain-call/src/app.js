const { UserService } = require('./service');

function processUser() {
  const svc = new UserService();
  svc.getUser().save();
}

module.exports = { processUser };
