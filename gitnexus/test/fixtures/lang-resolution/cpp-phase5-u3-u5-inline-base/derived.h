#pragma once

#include "base.h"

template<class T>
struct Derived : outer::v1::Base<T> {
  void g() {
    f();
  }
};
