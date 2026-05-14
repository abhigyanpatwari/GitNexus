#pragma once

#include "base.h"

template<class T>
struct Derived : Base<T> {
  void g() {
    this->f();
  }
  void k() {
    this->base_method();
  }
  int h() {
    return this->i;
  }
};
