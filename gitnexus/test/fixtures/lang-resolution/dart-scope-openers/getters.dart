// An accessor publishes no return binding. A member getter's must not type a
// same-named untyped receiver outside its class, nor the bare reads of another
// class declaring a same-named getter of a different type; a top-level
// getter's must not type an untyped parameter or local of its name.
import 'models.dart';

class Addr {
  void save() {}
}

class Box2 {
  Addr get cs => Addr();

  void own() {
    cs.save();
  }
}

class Crate {
  Other get cs => Other();

  void own() {
    cs.save();
  }
}

void f() {
  var cs = compute();
  cs.save();
}

void g(dynamic cs) {
  cs.save();
}

Other get top => Other();

void untypedParam(dynamic top) {
  top.save();
}

void untypedLocal() {
  var top = items.first;
  top.save();
}

void moduleGetterRebound(Address top) {
  items.forEach((top) => top.save());
}
