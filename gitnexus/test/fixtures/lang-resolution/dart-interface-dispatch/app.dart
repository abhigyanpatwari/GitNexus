import 'sql_repository.dart';

void main() {
  final repo = SqlRepository();
  repo.find(1);
  repo.save("test");
}
