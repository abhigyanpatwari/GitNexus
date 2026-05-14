#pragma once

#include "base.h"

template<class T>
struct Derived : Base<T> {
  void g() {
    this->f();
  }
  int h() {
    return this->i;
  }
};
