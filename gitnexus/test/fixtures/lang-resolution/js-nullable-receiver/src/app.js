const { User } = require('./user');
const { Repo } = require('./repo');

/**
 * @param {User | null} user
 * @param {Repo | null} repo
 */
function processEntities(user, repo) {
  if (user) user.save();
  if (repo) repo.save();
}
