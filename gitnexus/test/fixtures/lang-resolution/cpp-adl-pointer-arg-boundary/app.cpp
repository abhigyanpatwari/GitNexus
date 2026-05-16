#include "audit.h"

namespace app {
  void run() {
    audit::Event* p;
    record(p);
  }
}
