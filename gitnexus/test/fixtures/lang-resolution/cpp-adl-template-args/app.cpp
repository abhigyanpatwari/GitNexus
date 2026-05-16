#include "audit.h"

namespace app {
  void run() {
    std::vector<N::T> v;
    apply(v);
  }

  void runNested() {
    std::map<std::string, std::vector<N::T>> m;
    applyNested(m);
  }

  void runArray() {
    std::array<N::T, 4> a;
    applyArray(a);
  }

  void runStdConflict() {
    std::vector<N::T> v;
    applyStdConflict(v);
  }
}
