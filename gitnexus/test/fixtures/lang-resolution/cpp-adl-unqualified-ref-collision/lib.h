#pragma once

namespace alpha {
  // `worker` exists in both alpha and beta namespaces.
  void worker();
  void run_with(void (*fn)());
}

namespace beta {
  void worker();
  void run_with(void (*fn)());
}
