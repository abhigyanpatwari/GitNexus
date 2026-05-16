#include "color.h"

namespace app {
  void run() {
    color::Channel ch = color::Channel::R;
    serialize(ch);
  }
}
