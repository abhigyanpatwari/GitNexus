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
