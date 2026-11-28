#nullable enable
namespace Other {
 public class Foo {}
 public struct Number {}
 class WrongRef : Base<global::Ns.Foo?> { public void M(Foo? value) {} }
 class WrongStruct : Base<global::Ns.Number?> { public void M(Number? value) {} }
}
