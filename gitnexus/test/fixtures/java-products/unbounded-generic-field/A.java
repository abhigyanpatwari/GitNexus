
class User {}
interface Repo<T> { void save(T x); }
class UserRepo implements Repo<User> { public void save(User x) {} }
class Svc {
  private Repo<? extends User> wild;
  private Repo raw;
  void runWildcard(User u) { this.wild.save(u); }
  void runRaw(User u) { this.raw.save(u); }
}
