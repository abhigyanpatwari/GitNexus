#include "data.h"

// Outer namespace has a non-callable `swap` (variable).
namespace app {
  int swap = 0;

  namespace inner {
    // Inner namespace re-declares `swap` as a function.
    void swap(int, int);

    void run() {
      data::Pair a, b;
      // Ordinary lookup finds `inner::swap(int,int)` first (callable at
      // nearest scope). The outer `app::swap` variable should NOT suppress
      // ADL because ordinary lookup stopped at `inner` scope where a
      // callable was found. ADL contributes `data::swap(Pair&,Pair&)` which
      // wins via argTypes narrowing.
      swap(a, b);
    }
  }
}
