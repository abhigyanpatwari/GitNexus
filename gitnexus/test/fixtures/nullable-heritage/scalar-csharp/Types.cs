#nullable enable
namespace Ns { public class Foo {} public struct Number {} }
public class Base<T> { public virtual void M(T value) {} }
namespace Ns {
 class FromGlobal : Base<global::Ns.Foo?> { public override void M(Foo? value) {} }
 class FromRelative : Base<Ns.Foo?> { public override void M(Foo? value) {} }
 class ToGlobal : Base<Foo?> { public override void M(global::Ns.Foo? value) {} }
 class ToRelative : Base<Foo?> { public override void M(Ns.Foo? value) {} }
 class StructFrom : Base<global::Ns.Number?> { public override void M(Number? value) {} }
 class StructTo : Base<Number?> { public override void M(global::Ns.Number? value) {} }
 class StructDecoy : Base<global::Ns.Number?> { public void M(Number value) {} }
}
namespace BoxSpace { public class Wrapper<T> {} public class Named {} }
class Generic<T> { public virtual void F(global::BoxSpace.Wrapper<T> value) {} }
class Grounded : Generic<global::BoxSpace.Named> { public override void F(global::BoxSpace.Wrapper<global::BoxSpace.Named> value) {} }
class GroundedDecoy : Generic<global::BoxSpace.Named> { public void F(global::BoxSpace.Wrapper<string> value) {} }
namespace Ns {
 class Unmarked : Base<Foo?> { public override void M(global::Ns.Foo value) {} }
 class ExplicitRefDecoy : Base<Foo?> { public void M(global::Other.Foo? value) {} }
 class ExplicitValueDecoy : Base<Number?> { public void M(Other.Number? value) {} }
 class ByRefBase<T> { public virtual void R(ref T value) {} }
 class ByRef : ByRefBase<Foo?> { public override void R(ref global::Ns.Foo? value) {} }
 class StructHop<T> : Base<T?> where T : struct {}
 class ValueThroughHop : StructHop<global::Ns.Number> { public override void M(Number? value) {} }
}
