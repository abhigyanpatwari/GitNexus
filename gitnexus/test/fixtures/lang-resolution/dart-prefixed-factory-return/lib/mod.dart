class C {
  int m() => 1;
}

class Other {
  int m() => 2;
}

C make() => C();

untyped() => C();

Future<C> makeAsync() async => C();
