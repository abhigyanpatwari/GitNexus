// A second spelling of a typed parameter's name that declares nothing — the
// parameter of a function-typed parameter, a pattern field label, a pattern
// assignment — keeps the annotation, even beside a same-named method.
import 'models.dart';

class Point {
  final Object x = 0;
}

class Maker {
  Other x() => Other();
}

void fnTyped(Address x, void cb(Address x)) {
  x.save();
}

void objectLabel(Address x, Object o) {
  switch (o) {
    case Point(x: var q):
      use(q);
  }
  x.save();
}

void recordLabel(Address x, ({Object x, Object n}) o) {
  final (x: q, n: m) = o;
  use(q);
  x.save();
}

void swap(Address x, Address y) {
  (x, y) = (y, x);
  x.save();
}

// A for-in variable DOES declare `x`: withheld, owned, a recorded drop.
void loop(Address x) {
  for (final x in items) {
    use(x);
  }
  x.save();
}
