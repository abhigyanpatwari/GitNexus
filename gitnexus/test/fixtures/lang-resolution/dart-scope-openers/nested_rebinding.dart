// A typed parameter keeps its annotation when a loop, a catch body or an enum
// method's loop rebinds the name in a scope of its own, even beside a
// same-named binding further out (a function's or a method's hoisted return,
// an enum field). A collection `for` element shares the function's scope, so
// there the annotation is withheld and every site of the name stops at the
// untyped binder. An untyped parameter behind a documentation comment is still
// its function's binder.
import 'models.dart';

Other ds() => Other();

void forIn(Address ds) {
  for (final ds in items) {
    use(ds);
  }
  ds.save();
}

class Depot {
  Other es() => Other();
  Other fs() => Other();
  Other gs() => Other();
}

void caught(Address es) {
  try {
    use(es);
  } catch (es) {
    use(es);
  }
  es.save();
}

enum Kind {
  a(null);

  const Kind(this.depot);
  final Other? depot;

  void moved(Address depot) {
    for (final depot in items) {
      use(depot);
    }
    depot.save();
  }
}

void collect(Address fs, List<Other> others) {
  final thunks = [for (final fs in others) () => fs.save()];
  use(thunks);
  fs.save();
}

void docUntyped(gs)
/// the parameter is untyped
{
  gs.save();
}
