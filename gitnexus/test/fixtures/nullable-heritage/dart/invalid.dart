import 'models.dart' as p;
import 'types.dart';

// The Dart analyzer rejects this override because the inherited parameter accepts null.
class Narrow extends Mid<String> { @override void accept(String value) {} }

class WrongArgument extends Mid<List<String>> {
  @override void accept(List<int>? value) {}
}
class WrongNested extends Mid<p.Box<Map<String, List<int?>>>> {
  @override void accept(p.Box<Map<String, List<String?>>>? value) {}
}
