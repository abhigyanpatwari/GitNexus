#include "audit.h"

namespace app {
  void run() {
    void (*fp)();
    audit::Event e;
    record(e);
  }
}
