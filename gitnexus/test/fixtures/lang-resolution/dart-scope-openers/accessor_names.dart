// A bare accessor read in a sibling member is `this.name`: the accessor's name
// belongs to its class, so the receiver walk stops there and never reaches the
// hoisted return of a same-named method in another class.
import 'models.dart';

class Mint {
  Other cs() => Other();
  Other wr() => Other();
  Other st() => Other();
  Other cf() => Other();
}

class Gate {
  Address get cs => Address();

  void probe() {
    cs.save();
  }

  Address get wr => Address();
  set wr(Address value) {}

  void probePair() {
    wr.save();
  }

  static Address get st => Address();

  void probeStatic() {
    st.save();
  }
}

class Plain {
  Address cf = Address();

  void probeField() {
    cf.save();
  }
}
