class DataService {
  Future<String> fetchUser(int id) async {
    return "user-$id";
  }

  Stream<int> countUp(int limit) async* {
    for (var i = 0; i < limit; i++) {
      yield i;
    }
  }

  Iterable<String> generateNames(int count) sync* {
    for (var i = 0; i < count; i++) {
      yield "name-$i";
    }
  }

  String formatName(String name) {
    return name.toUpperCase();
  }
}
