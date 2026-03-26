// ── Imports and re-exports ──────────────────────────────────────────────
import 'dart:convert';
import 'package:http/http.dart' as http;
export 'src/models.dart';

// ── Private symbols (should be filtered by exportChecker) ──────────────
void _internalSetup() {
  print('internal');
}

class _PrivateCache {
  final Map<String, dynamic> _data = {};
}

// ── Call sites: expression statement ────────────────────────────────────
void expressionCalls() {
  fetchUsers();
  processData();
}

// ── Call sites: return statement ────────────────────────────────────────
String returnCall() {
  return formatOutput();
}

// ── Call sites: variable assignment ─────────────────────────────────────
void assignmentCalls() {
  var result = computeScore();
  final user = loadUser();
}

// ── Type resolution: explicit annotations ──────────────────────────────
void typedDeclarations() {
  User admin = User('admin');
  User? maybeUser = null;
  List<String> names = [];
}

// ── Type resolution: constructor inference ──────────────────────────────
void constructorInference() {
  var dog = Dog('Rex', 'GSD');
  final repo = Repository<User>();
  var named = Dog.unknown();
}

// ── Type resolution: for-loop ──────────────────────────────────────────
void loopTypes(List<User> users) {
  for (var user in users) {
    print(user);
  }
  for (User u in users) {
    print(u);
  }
}

// ── Flutter widget pattern ─────────────────────────────────────────────
class UserWidget extends StatelessWidget {
  final String username;

  const UserWidget({required this.username});

  @override
  Widget build(BuildContext context) {
    return Text(username);
  }
}

class CounterPage extends StatefulWidget {
  @override
  State<CounterPage> createState() => _CounterPageState();
}

class _CounterPageState extends State<CounterPage> {
  int _count = 0;

  @override
  void initState() {
    super.initState();
  }

  @override
  void dispose() {
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Text('$_count');
  }
}

// ── Framework detection patterns ───────────────────────────────────────
class UserBloc extends Bloc<UserEvent, UserState> {
  @override
  void onEvent(UserEvent event) {}
}

class SettingsNotifier extends ChangeNotifier {
  void toggle() {
    notifyListeners();
  }
}

// ── Stub types for compilation (not real Flutter) ──────────────────────
class StatelessWidget {}
class StatefulWidget {}
class State<T> {
  void initState() {}
  void dispose() {}
}
class Widget {}
class BuildContext {}
class Text extends Widget {
  Text(String text);
}
class Bloc<E, S> {
  void onEvent(E event) {}
}
class ChangeNotifier {
  void notifyListeners() {}
}
class User {
  final String name;
  User(this.name);
}
class Dog {
  Dog(String name, String breed);
  factory Dog.unknown() => Dog('?', '?');
}
class Repository<T> {}
class UserEvent {}
class UserState {}

// ── Helper functions for call extraction tests ─────────────────────────
List<User> fetchUsers() => [];
String processData() => '';
String formatOutput() => '';
int computeScore() => 0;
User loadUser() => User('test');
