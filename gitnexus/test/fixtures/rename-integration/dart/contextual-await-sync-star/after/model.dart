int target() => 1;
Iterable<int> caller() sync* { yield target(); }
