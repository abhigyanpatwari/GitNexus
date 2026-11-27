package app;
import java.util.List;
class NestRec {
  List<Other> users;
  record Page(List<User> users) {
    void inside() { for (var u : users) u.save(); }
  }
  void nrFor() { for (var u : users) u.save(); }
  void nrLambda() { users.forEach(u -> u.save()); }
  void localRecord() {
    record Local(List<User> users) {}
    for (var u : users) u.save();
  }
}