#include "models.h"

// The `->` BASE receiver. Before structural receiver typing this emitted no
// CALLS edge to `save` at all, and `cpp-chain-call/` could not catch it because
// that fixture uses the value `.` form, which already worked.
void pointerArrowChain(Service* svc) {
    svc->getUser()->save();
}

// Control: same chain, same `->save()` tail, value `.` on the base. Resolved
// before this work and must keep resolving.
void valueDotChain(Service svc) {
    svc.getUser()->save();
}
