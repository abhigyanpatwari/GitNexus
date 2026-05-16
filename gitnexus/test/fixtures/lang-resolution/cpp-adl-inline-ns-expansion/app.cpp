#include "audit.h"

namespace app {
  void run() {
    audit::Event e;
    record(e);
  }
}
