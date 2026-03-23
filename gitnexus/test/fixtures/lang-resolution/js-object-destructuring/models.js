/**
 * @class
 */
class Address {
  /** @returns {boolean} */
  save() { return true; }
}

/**
 * @class
 */
class User {
  constructor() {
    /** @type {Address} */
    this.address = new Address();
  }
}

module.exports = { Address, User };
