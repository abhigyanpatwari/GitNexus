package app;
import static lib.Outer.*;
class Static {
  void param(Inner.User x) { x.save(); }
  void local() { Inner.User x = null; x.save(); }
}