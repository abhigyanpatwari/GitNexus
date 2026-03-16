const { User } = require('./user');
const { Repo } = require('./repo');

/**
 * @returns {Promise<User>}
 */
async function fetchUser(name) {
  return new User(name);
}

/**
 * @returns {Promise<Repo>}
 */
async function fetchRepo(path) {
  return new Repo(path);
}

async function processUser() {
  const user = await fetchUser('alice');
  user.save();
}

async function processRepo() {
  const repo = await fetchRepo('/data');
  repo.save();
}
