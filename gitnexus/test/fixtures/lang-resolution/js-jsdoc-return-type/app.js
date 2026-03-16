const { User } = require('./user');
const { Repo } = require('./repo');

/**
 * @returns {User}
 */
function getUser(name) {
  return new User(name);
}

/**
 * @returns {Repo}
 */
function getRepo(path) {
  return new Repo(path);
}

function processUser() {
  const user = getUser('alice');
  user.save();
}

function processRepo() {
  const repo = getRepo('/data');
  repo.save();
}

/**
 * @param {User} user the user to handle
 */
function handleUser(user) {
  user.save();
}

/**
 * @param {Repo} repo the repo to handle
 */
function handleRepo(repo) {
  repo.save();
}
