#nullable enable
namespace Decoy {
 using X = Other;
 class AliasNegative : Base<global::Ns.Foo?> { public void M(X.Foo? value) {} }
}
