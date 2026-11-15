import 'mod.dart' as ip;

void immediateLoad() {
  ip.loadLibrary();
}

void immediateLoadTearOff() {
  final load = ip.loadLibrary;
  load();
}

int immediateLoadResult() {
  final pending = ip.loadLibrary();
  return pending.timeout(const Duration(seconds: 5));
}

int immediateLoadChain() => ip.loadLibrary().timeout(const Duration(seconds: 5));

int immediateMembers() {
  ip.C();
  return ip.C.sm() + ip.C.sf;
}
