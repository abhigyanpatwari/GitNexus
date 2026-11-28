#nullable enable
class Box<T> {}
struct Packet<T> {}
class Base<T> where T : class? { public virtual void Accept(T? value) {} }
class Mid<X> : Base<X?> where X : class? {}
class Simple : Mid<string> { public override void Accept(string? value) {} }
class Constructed : Mid<Box<int>> { public override void Accept(Box<int> value) {} }
class Annotated : Mid<Box<int>> { public override void Accept(Box<int>? value) {} }
class Nested : Mid<Box<Box<int>>> { public override void Accept(Box<Box<int>> value) {} }
class WrongArg : Mid<Box<int>> { public void Accept(Box<string> value) {} }
class ValueBase<T> { public virtual void Accept(T value) {} }
class Lift<X> : ValueBase<X?> where X : struct {}
class Lifted : Lift<Packet<int>> { public override void Accept(Packet<int>? value) {} }
class ValueDecoy : Lift<Packet<int>> { public void Accept(Packet<int> value) {} }
class Explicit : Mid<global::Box<int>> { public override void Accept(global::Box<int>? value) {} }
class InnerReference : Mid<Box<string?>> { public override void Accept(Box<string> value) {} }
class DeepAnnotations : Mid<Box<Box<string?>?>?> { public override void Accept(Box<Box<string>> value) {} }
class InnerValueDecoy : Mid<Box<int?>> { public void Accept(Box<int> value) {} }
