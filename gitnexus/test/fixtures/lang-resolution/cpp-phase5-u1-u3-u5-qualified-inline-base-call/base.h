#pragma once

namespace outer {
  inline namespace v1 {
    template<class T>
    struct Base {
      void f();
    };

    void free_fn();
  }
}
