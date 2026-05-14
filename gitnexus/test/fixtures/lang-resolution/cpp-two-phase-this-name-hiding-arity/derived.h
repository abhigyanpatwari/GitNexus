#pragma once

#include "base.h"

template<class T>
struct Derived : Base<T> {
  void f(int);

  void g() {
    this->f();
  }
};
