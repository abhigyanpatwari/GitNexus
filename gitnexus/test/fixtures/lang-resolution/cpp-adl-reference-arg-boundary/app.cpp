#include "audit.h"

namespace app {
  void runRef() {
    audit::Event e;
    audit::Event& s = e;
    record(s);
  }

  void runConstRef() {
    audit::Event e;
    const audit::Event& constEventRef = e;
    recordConst(constEventRef);
  }

  void runPrimitiveRef() {
    int n = 0;
    int& r = n;
    note(r);
  }
}
