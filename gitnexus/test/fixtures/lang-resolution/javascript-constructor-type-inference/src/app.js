const { User } = require('./user');
const { Repo } = require('./repo');

function processEntities() {
  const user = new User();
  const repo = new Repo();
  user.save();
  repo.save();
}

module.exports = { processEntities };
