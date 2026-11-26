class Switches {
  Other x;
  void groupLocalEndsWithSwitch(int k) {
    switch (k) { case 1: User x = null; }
    var y = x;
    y.save();
  }
  void groupLocalInsideSwitch(int k) {
    switch (k) { case 1: User x = null; var w = x; w.save(); }
  }
}