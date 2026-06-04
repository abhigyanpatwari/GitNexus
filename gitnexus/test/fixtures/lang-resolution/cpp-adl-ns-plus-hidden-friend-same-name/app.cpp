#include "lib.h"

// Both call sites use an unqualified name with a lib::T argument, so ordinary
// lookup fails and ADL fires via T's associated namespace `lib`. `combine` is
// only reachable as a hidden friend (friendCandidates); `process` only as a
// namespace member (nsCandidates). Both must resolve — that is what proves
// pickCppAdlCandidates consults BOTH buckets when merging.

void call_friend() {
  lib::T a;
  lib::T b;
  combine(a, b);
}

void call_ns() {
  lib::T t;
  process(t);
}
