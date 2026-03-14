const { BaseModel } = require('./Base');

class User extends BaseModel {
  serialize() { return ''; }
}
module.exports = { User };
