package p;
class Switches {
  Repo repo;
  Switches() { var o = repo.other(); var c = o; c.save(); }
  void unbracedGroup(int k) { var o = repo.other(); switch (k) { case 1: var c = o; c.save(); break; } }
  void producerInGroup(int k) { switch (k) { case 1: var o = repo.other(); var c = o; c.save(); break; } }
  void switchExpressionGroup(int k) {
    var o = repo.other();
    int r = switch (k) { case 1: var c = o; c.save(); yield 1; default: yield 0; };
  }
  void writtenInGroup(int k) { var o = repo.other(); switch (k) { case 1: o = repo.user(); var c = o; c.save(); break; } }
  void writtenInLaterGroup(int k) {
    var o = repo.other();
    switch (k) { case 1: var c = o; c.save(); break; case 2: o = repo.user(); break; }
  }
}