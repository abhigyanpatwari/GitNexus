package q;
import static p.Outer.Inner;
import static p.Other.Inner;
class TwoUse { void run(Inner.Nested n) { n.save(); } }