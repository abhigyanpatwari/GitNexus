#pragma once

namespace ns {
  namespace a { namespace b {
    template<class T>
    struct Inner {
      void f();
    };
  } }

  template<class T>
  struct Derived : a::b::Inner<T> {
    void g() {
      this->f();
    }
  };
}

// Second Inner class at global scope forces multi-candidate path
// in populateCppDependentBases, exercising the namespace filter.
template<class T>
struct Inner {
  void g2();
};
