class Address {
  city = '';

  save() {
    // persist address
  }
}

class User {
  name = '';
  address = new Address();

  greet() {
    return this.name;
  }
}

class Config {
  static DEFAULT = new Config();

  validate() {
    return true;
  }
}

module.exports = { Address, User, Config };
