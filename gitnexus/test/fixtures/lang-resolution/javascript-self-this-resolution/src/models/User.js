class User {
  save() { return true; }
  process() {
    this.save();
  }
}
module.exports = { User };
