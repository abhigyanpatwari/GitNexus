const { User, Config } = require('./models');

function processUser(user) {
  user.address.save();
}

function validateConfig() {
  Config.DEFAULT.validate();
}
