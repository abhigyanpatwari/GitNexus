#nullable enable
namespace Client {
 using A = B;
 class SameAlias : Base<global::B.Foo<int>?> { public override void M(A.Foo<int> value) {} }
 class AliasProbe : Base<global::A.Foo<int>?> { public void M(A.Foo<int>? value) {} }
}
