#include "audit.h"

namespace app {
  void run() {
    audit::Event** pp;
    record(pp);
  }
}
