#pragma once

namespace audit {
  struct Event {};

  inline namespace v1 {
    void record(Event e);
  }
}

namespace other {
  void record(int x);
}
