package side;
import static java.lang.Math.*;
class WithMath {
  void take(java.lang.String value) {}
  void take(java.lang.Integer value) {}
  void pass(java.lang.String value) { take(value); }
  void param(Inner.User u) { u.save(); }
}