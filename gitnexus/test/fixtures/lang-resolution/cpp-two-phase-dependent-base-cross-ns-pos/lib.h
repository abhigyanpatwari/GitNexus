#pragma once

namespace ns::outer {
  namespace inner {
    template<class T>
    struct Inner {
      void f();
    };
  }

  template<class T>
  struct Derived : inner::Inner<T> {
    void g() {
      this->f();
    }
  };
}
