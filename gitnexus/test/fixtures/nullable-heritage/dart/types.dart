import 'models.dart' as p;

class Base<T> { void accept(T value) {} }
class Mid<X> extends Base<X?> {}
class Generic<T> extends Mid<T> { @override void accept(T? value) {} }
class Concrete extends Mid<String> { @override void accept(String? value) {} }
class Bounded<X extends Object> extends Base<X?> {}
class BoundedGeneric<T extends Object> extends Bounded<T> { @override void accept(T? value) {} }
class Direct extends Base<String?> { @override void accept(String? value) {} }

class Constructed extends Mid<List<String>> {
  @override void accept(List<String>? value) {}
}
class AlreadyNullable extends Mid<List<String>?> {
  @override void accept(List<String>? value) {}
}
class Nested extends Mid<p.Box<Map<String, List<int?>>>> {
  @override void accept(p.Box<Map<String,List<int?>>>? value) {}
}
