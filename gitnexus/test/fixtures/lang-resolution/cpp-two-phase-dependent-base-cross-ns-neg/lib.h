#pragma once

namespace ns::outer {
  namespace inner {
    // No Inner<T> declared here
  }

  template<class T>
  struct Derived : inner::Inner<T> {
    void g() {
      this->f();
    }
  };
}
