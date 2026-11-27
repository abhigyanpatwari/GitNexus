
class User {
  void save() {}
  public User clone() { return this; }
  public String toString() { return "user"; }
  void getClass() {}
}
class Other { void save() {} }
class List<T> { void save() {} }
class App {
  User[] field;
  User[] getUsers() { return field; }
  User trailingReturn()[] { return field; }
  void parameter(User[] users) { users[0].save(); }
  void trailingParameter(User users[]) { users[0].save(); }
  void varargs(User... users) { users[0].save(); }
  void local() { User[] users = null; users[0].save(); }
  void trailingLocal() { User users[] = null; users[0].save(); }
  void mixedScalar() { User first = null, second[] = null; first.save(); }
  void mixedArray() { User first = null, second[] = null; second[0].save(); }
  void mixedDimensions() { User[] first = null, second[] = null; first[0].save(); }
  void fieldElement() { this.field[0].save(); }
  void methodElement() { getUsers()[0].save(); }
  void trailingMethodElement() { trailingReturn()[0].save(); }
  void unindexed(User[] users) { users.save(); }
  void partial(User[][] users) { users[0].save(); }
  void mixedPartial() { User[] first = null, second[] = null; second[0].save(); }
  void listIndex(List<User> users) { users[0].save(); }
  void cloneArray(User[] users) { users.clone(); }
  void stringifyArray(User[] users) { users.toString(); }
  void classArray(User[] users) { users.getClass(); }
  void iterateArray(User[] users) { for (var user : users) user.save(); }
  void iterateList(java.util.List<User> users) { for (var user : users) user.save(); }
  void nested(User[][] users) { users[0][0].save(); }
  void nestedLocal() { User[][] users = null; users[0][0].save(); }
  void nestedTrailing(User[] users[]) { users[0][0].save(); }
  void nestedDeep(User[][][] users) { users[0][0][0].save(); }
  void nestedPartial(User[][][] users) { users[0][0].save(); }
}
