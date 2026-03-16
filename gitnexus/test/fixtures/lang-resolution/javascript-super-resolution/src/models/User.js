const { BaseModel } = require('./Base');

class User extends BaseModel {
  save() {
    super.save();
    return true;
  }
}
module.exports = { User };
