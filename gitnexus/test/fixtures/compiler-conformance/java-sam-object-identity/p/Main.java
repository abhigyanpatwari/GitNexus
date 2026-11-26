package p;
interface Local { boolean equals(Object x); void accept(Item it); }
interface Canonical { boolean equals(java.lang.Object x); void accept(Item it); }
class Main {
  void local(Local cb) {} void canonical(Canonical cb) {} void imported(Imported cb) {}
  void rejected() { local(x -> x.save()); }
  void accepted() { canonical(x -> x.save()); }
  void explicitlyImported() { imported(x -> x.save()); }
}
