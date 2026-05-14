#pragma once

#include "base.h"

namespace geom {

template<class T>
struct Derived : Base<T> {
  // Unqualified call to compute() inside a template body whose base is
  // dependent.  Two-phase lookup: the compiler does NOT look into
  // Base<T> for this name — so GitNexus must also suppress the edge.
  void g() {
    compute();
  }
  // Unqualified field access — same reasoning applies.
  int h() {
    return area;
  }
};

} // namespace geom
