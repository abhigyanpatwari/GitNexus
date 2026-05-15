#include "base_lib.h"

namespace app {
  struct Token : base_one::Base {};

  void run() {
    Token t;
    collide(t);
  }
}

namespace other {
  struct Token : base_two::Base {};
}
