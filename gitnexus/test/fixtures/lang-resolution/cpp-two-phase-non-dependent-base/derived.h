#pragma once

#include "concrete-base.h"

template<class T>
struct Derived : ConcreteBase {
  void g() {
    f();
  }
};
