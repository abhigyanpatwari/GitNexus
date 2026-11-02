int target() => 1;
Stream<int> caller() async* { yield target(); }
