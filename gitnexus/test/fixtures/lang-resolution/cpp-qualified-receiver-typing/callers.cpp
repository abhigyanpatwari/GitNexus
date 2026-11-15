#include "mod.h"
#include "other.h"
#include "a.h"

// Qualified type spellings: `rp::C` must reach rp::C, never the global C that
// is visible here through other.h.
int declared_init() { rp::C x = rp::make(); return x.m(); }
int param_ns(rp::C x) { return x.m(); }
int param_ns_ptr(rp::C* x) { return x->m(); }
int param_template(rp::Box<int> b) { return b.m(); }
int bare_global() { C x; return x.m(); }

// Qualified declarations with no initializer.
int declared_ns() { rp::C x; return x.m(); }
int declared_ns_ptr() { rp::C* x = nullptr; return x->m(); }

// Qualified brace-init and member field.
int brace_ns() { auto x = rp::C{}; return x.m(); }

namespace b {
struct Config {
  int m() { return 7; }
};
int param_qualified(a::Config x) { return x.m(); }
int param_local(Config x) { return x.m(); }
int brace_qualified() { auto x = a::Config{}; return x.m(); }
struct Holder {
  a::Config cfg;
  int field_qualified() { return cfg.m(); }
};
}  // namespace b

// Factories declared only by header prototypes (definitions live in mod.cpp,
// which nothing includes).
int auto_plain() { auto x = makeD(); return x.m(); }
int inline_plain() { return makeD().m(); }
int auto_ptr() { auto p = makeDp(); return p->m(); }
int global_factory() { auto y = make(); return y.m(); }

// A block-scope `E y();` declares a local function; it must not leak a
// file-level `y => E` binding to other functions.
int vexing() { E y(); return 0; }
int uses_vexing_name() { return y.m(); }

// Qualified factory callee.
int auto_ns() { auto x = rp::make(); return x.m(); }
int inline_ns() { return rp::make().m(); }
int ctor_ns() { auto x = rp::C(); return x.m(); }

// An unknown qualified factory types nothing, and must not let the inner `x`
// fall through to the outer `D x`.
int shadowed_auto() {
  D x;
  {
    auto x = rp::unknown();
    return x.m();
  }
}
