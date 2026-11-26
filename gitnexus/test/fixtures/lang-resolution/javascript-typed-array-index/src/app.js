const { User, Decoy } = require('./models');

/** @param {User[]} repos */
function paramArray(repos) {
  repos[0].save();
}

/** @param {Array<User>} repos */
function paramGeneric(repos) {
  repos[0].save();
}

/** @returns {User[]} */
function loadUsers() {
  return [new User()];
}

function typedConst() {
  /** @type {User[]} */
  const repos = loadUsers();
  repos[0].save();
}

/** @param {Decoy[]} decoys */
function decoyArray(decoys) {
  decoys[0].save();
}

/** @param {User[][]} grid */
function partialIndex(grid) {
  grid[0].save();
}

function untyped(repos) {
  repos[0].save();
}

module.exports = { paramArray, paramGeneric, typedConst, decoyArray, partialIndex, untyped };

/** @param {Map<string, User>} byName */
function mapIndex(byName) {
  byName[0].save();
}

/** @param {Promise<User>} pending */
function promiseIndex(pending) {
  pending[0].save();
}
