#pragma once

namespace geom {

template<class T>
struct Base {
  void compute();
  int area;
};

// Free function inside the same namespace — no ownerId, so the
// class-owned filter does NOT apply to this candidate.  It is instead
// suppressed by the namespace-nesting filter (isCppDefGloballyVisible).
// The test therefore exercises a candidate path that is orthogonal to
// the class-owned filter, proving the overall suppression stack is
// robust even when ownerId-based blocking is absent.
void compute();

} // namespace geom
