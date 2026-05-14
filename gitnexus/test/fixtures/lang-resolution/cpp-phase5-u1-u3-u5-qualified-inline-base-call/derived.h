#pragma once

#include "base.h"

template<class T>
struct Derived : outer::v1::Base<T> {
  void g() {
    outer::v1::Base<T>::f();
    outer::v1::free_fn();
  }
};
