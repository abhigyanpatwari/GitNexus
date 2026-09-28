void runSweep() {}
void runThen() {}
void runElse() {}

void ifNull(void Function()? override) {
  final run = override ?? runSweep;
  run();
}

void runLeft() {}

void callableLeft(void Function() fallback) {
  final run = runLeft ?? fallback;
  run();
}

void conditional(bool fast) {
  final run = fast ? runThen : runElse;
  run();
}
