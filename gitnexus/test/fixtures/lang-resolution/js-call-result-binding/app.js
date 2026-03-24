const { getUser } = require('./service');

function processUser() {
  const user = getUser('alice');
  user.save();
}
