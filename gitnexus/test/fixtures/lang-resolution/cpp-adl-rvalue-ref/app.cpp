#include "audit.h"

namespace app {
  void runRvalueRef() {
    audit::Event e;
    audit::Event&& rr = static_cast<audit::Event&&>(e);
    record(rr);
  }
}
