#include "base_lib.h"

namespace app {
  struct Derived : base_lib::Base {};
  struct MultiLevel : middle_lib::Mid {};
  struct DiamondDerived : diamond_lib::LeftBranch, diamond_lib::RightBranch {};

  void run_single() {
    Derived d;
    log(d);
  }

  void run_multi() {
    MultiLevel m;
    trace(m);
  }

  void run_diamond() {
    DiamondDerived d;
    ping(d);
  }
}
