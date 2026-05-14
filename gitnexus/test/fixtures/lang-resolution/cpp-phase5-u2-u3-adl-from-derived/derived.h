#pragma once

#include "base.h"

template<class T>
struct Derived : Base<T> {
  void g() {
    audit::Event e;
    record(e);
  }
};
