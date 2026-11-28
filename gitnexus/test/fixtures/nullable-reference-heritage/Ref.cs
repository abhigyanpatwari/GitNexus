#nullable enable
class Payload {}
struct Value {}
class Base<T> where T : class? { public virtual void M(T? item) {} }
class Opaque<T> { public virtual void M(T item) {} }
class Simple : Base<Payload> { public override void M(Payload item) {} }
class Annotated : Base<Payload?> { public override void M(Payload item) {} }
class Hop<X> : Base<X?> where X : class? {}
class TwoHop : Hop<Payload> { public override void M(Payload item) {} }
class TwoHopMarked : Hop<Payload?> { public override void M(Payload? item) {} }
class DirectOpaque : Opaque<Payload?> { public override void M(Payload item) {} }
class StructPositive : Opaque<Value?> { public override void M(Value? item) {} }
class StructDecoy : Opaque<Value?> { public void M(Value item) {} }
struct @byte {}
class EscapedPositive : Opaque<@byte?> { public override void M(@byte? item) {} }
class EscapedDecoy : Opaque<@byte?> { public void M(@byte item) {} }
