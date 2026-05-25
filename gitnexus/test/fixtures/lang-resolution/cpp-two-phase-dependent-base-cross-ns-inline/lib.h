#pragma once

namespace ns {
  inline namespace v1 {
    template<class T>
    struct Base {
      void f();
    };
  }

  template<class T>
  struct Derived : v1::Base<T> {
    void g() {
      this->f();
    }
  };
}
