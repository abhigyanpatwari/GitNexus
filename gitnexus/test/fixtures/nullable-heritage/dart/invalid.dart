import 'types.dart';

// The Dart analyzer rejects this override because the inherited parameter accepts null.
class Narrow extends Mid<String> { @override void accept(String value) {} }
