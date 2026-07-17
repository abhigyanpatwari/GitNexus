class Identifiable {}

class SequenceLike<T> {}

extension type const UserId(String value) implements Identifiable {
  String describe() => value;
}

extension type const EmptyId(String value) {}

extension type Celsius(double degrees) {
  double toFahrenheit() => degrees * 9 / 5 + 32;
}

extension type Box<T>(List<T> value) implements SequenceLike<T> {
  T first() => value.first;
}

extension Fancy on String {
  int get doubledLength => length * 2;
  String shout() => toUpperCase();
}
