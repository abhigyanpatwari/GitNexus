#include "audit.h"

namespace app {
  void run() {
    // Block-scope function declaration (not via using-declaration).
    // Per ISO C++ [basic.lookup.argdep], this suppresses ADL — even
    // though `e` is audit::Event, audit::record should NOT be discovered.
    void record(int);

    audit::Event e;
    record(e);
  }
}
