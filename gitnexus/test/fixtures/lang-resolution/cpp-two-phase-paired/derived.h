#pragma once

#include "base.h"

template<class T>
struct Derived : Base<T> {
  void g_unqualified() {
    f();
  }

  void g_this() {
    this->f();
  }
};
