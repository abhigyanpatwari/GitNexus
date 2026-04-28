import 'repository.dart';

class SqlRepository implements Repository {
  @override
  String find(int id) {
    return "found";
  }

  @override
  bool save(String entity) {
    return true;
  }
}
