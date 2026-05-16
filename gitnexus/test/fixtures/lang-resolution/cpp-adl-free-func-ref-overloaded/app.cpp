#include "utils.h"

namespace caller {
  void run() {
    with_callback(utils::worker);
  }
}
