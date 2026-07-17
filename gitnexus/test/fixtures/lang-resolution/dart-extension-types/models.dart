extension type const UserId(String value) {
  String describe() => value;
}

extension type const EmptyId(String value) {}

extension type Celsius(double degrees) {
  double toFahrenheit() => degrees * 9 / 5 + 32;
}

extension type Box<T>(List<T> value) {
  T first() => value.first;
}

extension Fancy on String {
  int get doubledLength => length * 2;
  String shout() => toUpperCase();
}
