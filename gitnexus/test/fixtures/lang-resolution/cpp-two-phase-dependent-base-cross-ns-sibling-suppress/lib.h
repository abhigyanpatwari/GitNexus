#pragma once

namespace mylib {
  namespace detail {
    template<class T>
    struct Inner {
      void f_a();
    };
  }
  namespace public_api {
    template<class T>
    struct Inner {
      void f_b();
    };
  }

  template<class T>
  struct Derived : detail::Inner<T> {
    void g() {
      this->f_a();
    }
  };
}
