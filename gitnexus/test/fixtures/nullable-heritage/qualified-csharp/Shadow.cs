#nullable enable
namespace Shadow {
 namespace A { public class Foo<T> {} }
 class NamespaceDecoy : Base<global::A.Foo<int>?> { public void M(A.Foo<int>? value) {} }
 class NestedNamespace : Base<global::Shadow.A.Foo<int>?> { public override void M(A.Foo<int>? value) {} }
}
