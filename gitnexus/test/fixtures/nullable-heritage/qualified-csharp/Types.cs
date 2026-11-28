#nullable enable
namespace A { public class Foo<T> {} }
namespace N { public class Box<T> {} }
class Base<T> { public virtual void M(T value) {} }
class Mid<T> : Base<global::N.Box<T?>> where T : struct {}
class Lifted : Mid<int> { public override void M(global::N.Box<int?> value) {} }
class LiftDecoy : Mid<int> { public void M(global::N.Box<int> value) {} }
class Open<T> : Base<global::N.Box<T?>> {}
class OpenValue : Open<int> { public override void M(global::N.Box<int> value) {} }
class OpenDecoy : Open<int> { public void M(global::N.Box<int?> value) {} }
class OpenNullable : Open<int?> { public override void M(global::N.Box<int?> value) {} }
class Ref<T> : Base<global::N.Box<T?>> where T : class? {}
class RefString : Ref<string?> { public override void M(global::N.Box<string?> value) {} }
namespace B {
 class Collision : Base<A.Foo<int>?> {}
 class Right : Collision { public override void M(A.Foo<int>? value) {} }
 class Wrong : Collision { public void M(Foo<int>? value) {} }
 class RootRight : Base<global::A.Foo<int>?> { public override void M(global::A.Foo<int>? value) {} }
 class RootWrong : Base<global::A.Foo<int>?> { public void M(Foo<int>? value) {} }
}
