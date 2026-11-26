
class User {}
interface Repo<T> { void save(T x); }
class UserRepo implements Repo<User> { public void save(User x) {} }
interface Plain { void save(User x); }
class PlainRepo implements Plain { public void save(User x) {} }
class GenericSvc {
  private Repo<User> repo;
  void runGeneric(User u) { this.repo.save(u); }
}
class ControlSvc {
  private Plain plain;
  void runControl(User u) { this.plain.save(u); }
}
