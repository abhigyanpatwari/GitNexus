import 'mod.dart' deferred as dp hide loadLibrary;

Future<void> deferredLoad() async {
  await dp.loadLibrary();
}

void deferredLoadTearOff() {
  final load = dp.loadLibrary;
  load();
}

Future<int> deferredLoadResult() async {
  final pending = dp.loadLibrary();
  await pending.timeout(const Duration(seconds: 5));
  return dp.feature();
}

Future<void> deferredLoadChain() async {
  await dp.loadLibrary().timeout(const Duration(seconds: 5));
}

Future<int> deferredMembers() async {
  await dp.loadLibrary();
  dp.C();
  return dp.C.sm() + dp.C.sf;
}
