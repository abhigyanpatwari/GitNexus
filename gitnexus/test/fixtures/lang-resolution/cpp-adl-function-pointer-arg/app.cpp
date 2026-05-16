#include "audit.h"

namespace app {
  void run() {
    void (*g)();
    record(g);
  }
}
