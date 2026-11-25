package app;
class Noise<User> {}
class App {
  void run(User[] users) { for (User user : users) user.save(); }
  <Other> void unrelated() {}
  void run2(Other[] others) { for (Other other : others) other.save(); }
  <User> void generic(User[] users) { for (User user : users) user.save(); }
}