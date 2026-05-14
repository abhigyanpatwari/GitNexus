#pragma once

#include "base.h"
#include "helpers.h"

template<class T>
struct D : Base<T> {
  void g() {
    utils::ns_helper();
  }
};
