
class Demo {
  static void target() {}
  static void invoke(Runnable callback) { callback.run(); }
  static void main(String[] args) {
    Runnable first = Demo::target;
    Runnable second = first;
    invoke(second);
  }
}
