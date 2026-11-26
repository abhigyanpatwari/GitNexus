package q;
import static p.Outer.Inner;
class Use {
  void run(Inner.Nested n) { n.save(); }
  void local() { Inner.Nested n = null; n.save(); }
  void take(Inner.Nested n) {}
  void take(q.Inner.Nested n) {}
  void pass(Inner.Nested n) { take(n); }
}