#include "audit.h"

namespace app {
  void run() {
    audit::Event (*factory)();
    record(factory);
  }
}
