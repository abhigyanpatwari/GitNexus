namespace impl { struct AliasC { int m(); }; }
namespace alias = impl;
struct Holder { alias::AliasC c; int alias_field() { return c.m(); } };
int alias_brace() { auto c = alias::AliasC{}; return c.m(); }
struct A { int m(); };
struct B { int m(); };
struct Factory { A make(); };
B make();
int prototype_collision() { Factory factory; return factory.make().m(); }
namespace one { A overloaded(); }
namespace two { B overloaded(int); }
using namespace one;
using namespace two;
int using_overload() { return overloaded(1).m(); }
namespace rp { A produce(); }
template<class rp> struct Client {
 int dependent_bound() { auto x = rp::produce(); return x.m(); }
 int dependent_inline() { return rp::produce().m(); }
};
namespace outer { namespace nested { A produce(); } }
template<class outer> struct DeepClient {
 int dependent_outer() { return outer::nested::produce().m(); }
};
int qualified_positive() { return rp::produce().m(); }

struct AliasShadow {
 struct alias { struct AliasC { int m(); }; };
 int alias_shadowed() { auto value = alias::AliasC{}; return value.m(); }
};
