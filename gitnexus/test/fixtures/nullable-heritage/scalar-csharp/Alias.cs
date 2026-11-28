#nullable enable
namespace Client {
 using X = Ns;
 class AliasPositive : Base<global::Ns.Foo?> { public override void M(X.Foo? value) {} }
}
