#include "base_lib.h"

namespace app {
  struct HiddenDerived : HiddenBase {};
  struct MissingDerived : missing_ns::UnknownBase {};

  void run_hidden() {
    HiddenDerived d;
    hidden_probe(d);
  }

  void run_missing() {
    MissingDerived d;
    unresolved_probe(d);
  }
}
