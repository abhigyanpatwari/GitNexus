#include "audit.h"

namespace app {
  int record = 0;

  void run() {
    audit::Event e;
    record(e);
  }
}
