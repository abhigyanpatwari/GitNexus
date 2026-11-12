// A typed parameter whose body binds its name again keeps no annotation, and
// its scope owns the name: a same-named binding further out (a function's or
// a method's hoisted return, an enum field) never answers the receiver.
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
