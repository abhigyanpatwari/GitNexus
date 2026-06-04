// Cross-namespace same-tail nested heritage (#1993).
//
// NS1::A::Inner and NS2::A::Inner are distinct nested types whose scope-model
// def.qualifiedName both drops the enclosing namespace and reads `A.Inner`. They
// collide in the qualifiedNames resolution index, so resolveQualifiedInheritanceBase
// hit refuse-on-tie and the scope-walk fallback first-won to NS1's Inner — DB
// CROSS-WIRED its EXTENDS to NS1::A::Inner (DA resolved correctly only by that
// first-wins luck). The cross-wire still lands on a real node, so findDanglingEdges
// stays blind to it. The `namespacePrefix` sidecar breaks the tie (bridge-held):
// DA's enclosing namespace NS1 selects NS1::A::Inner.
namespace NS1 {
struct A {
  struct Inner {};
};
struct DA : A::Inner {};
}  // namespace NS1

namespace NS2 {
struct A {
  struct Inner {};
};
struct DB : A::Inner {};
}  // namespace NS2
