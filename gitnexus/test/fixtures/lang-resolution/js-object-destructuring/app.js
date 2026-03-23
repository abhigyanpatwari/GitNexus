const { getUser } = require('./service');

function processDestructured() {
  const user = getUser();
  const { address } = user;
  address.save();
}
