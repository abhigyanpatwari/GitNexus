class C {
  static int sf = 0;
  C();
  static int sm() => 2;
}

class Pending {
  int timeout(Duration limit) => 0;
}

Pending loadLibrary() => Pending();

int feature() => 1;
