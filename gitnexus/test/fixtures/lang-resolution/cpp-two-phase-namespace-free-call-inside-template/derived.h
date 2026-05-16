#pragma once

#include "base.h"
#include "helpers.h"

using utils::ns_helper_2;

template<class T>
struct D : Base<T> {
  void g() {
    utils::ns_helper();
    ns_helper_2();
  }
};
