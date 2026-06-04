// Same-tail structs in sibling ANONYMOUS namespaces (#1995).
//
// An anonymous `namespace { }` is a namespace_definition with no `name` child, so
// extractScopeSegmentsFromNode returns [] and both `Inner` structs qualified to the
// bare `Inner` and merged onto one node — from_anon_a / from_anon_b cross-wired. A
// deterministic per-block discriminator (derived from the namespace node's start
// byte) keeps the two blocks' types distinct.
namespace {
struct Inner {
  void from_anon_a() {}
};
}
namespace {
struct Inner {
  void from_anon_b() {}
};
}
