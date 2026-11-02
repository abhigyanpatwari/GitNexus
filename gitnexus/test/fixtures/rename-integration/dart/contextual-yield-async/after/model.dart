int target() => 1;
Future<int> caller() async { return target(); }
