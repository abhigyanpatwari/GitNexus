void runSweep() {}
void runThen() {}
void runElse() {}

void ifNull(void Function()? override) {
  final run = override ?? runSweep;
  run();
}

void conditional(bool fast) {
  final run = fast ? runThen : runElse;
  run();
}
