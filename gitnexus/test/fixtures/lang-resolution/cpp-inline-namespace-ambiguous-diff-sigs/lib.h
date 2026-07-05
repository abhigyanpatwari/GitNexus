#pragma once

namespace outer {
  inline namespace v1 {
    void foo(int x);
  }
  inline namespace v2 {
    void foo(double y);
  }
}
