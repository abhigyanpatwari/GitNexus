package h;
public class Caller {
  models.Other x;
  void c0(Harness h) {
    h.take0(x -> x.save());
    h.accept(x -> x.getName());
    h.accept((a, b) -> a.save());
  }
  void take(Harness h) { h.take0(x -> x.save()); }
  void single(Harness h) { h.accept(x -> x.save()); }
  void pair(Harness h) { h.accept((a, b) -> a.getName()); }
  void qualified(Harness h) { h.qualified(x -> x.save()); }
}
