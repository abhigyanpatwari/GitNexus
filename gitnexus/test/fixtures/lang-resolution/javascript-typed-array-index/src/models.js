class User {
  save() {
    return true;
  }
}

class Decoy {
  save() {
    return false;
  }
}

module.exports = { User, Decoy };
