#pragma once

#include "base.h"

template<class T>
struct Derived : Base<T> {
  void g() {
    f();
  }
  int h() {
    return i;
  }
};
