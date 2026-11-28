#nullable enable

class Base<T> {
    public virtual void Accept((T, int) value) {}
}

class Mid<X, Unused> : Base<X?> where X : struct {}
class Child : Mid<int, decimal> {
    public override void Accept((int?, int) value) {}
}
class Decoy : Mid<int, decimal> {
    public void Accept((int, int) value) {}
    public void Accept((decimal?, int) value) {}
}
class Direct : Base<int?> {
    public override void Accept((int?, int) value) {}
}

class ReferenceMid<X> : Base<X?> where X : class? {}
class AlreadyNullable : ReferenceMid<string?> {
    public override void Accept((string?, int) value) {}
}

class BareBase<T> {
    public virtual void Accept(T value) {}
}
class BareMid<X> : BareBase<X?> where X : struct {}
class BareGeneric<T> : BareMid<T> where T : struct {
    public override void Accept(T? value) {}
}
class BareChild : BareMid<int> {
    public override void Accept(int? value) {}
}
class BareDecoy : BareMid<int> {
    public void Accept(int value) {}
}
class OpenMid<X> : Base<X?> {}
class OpenChild : OpenMid<int> {
    public override void Accept((int, int) value) {}
}
class OpenDecoy : OpenMid<int> {
    public void Accept((int?, int) value) {}
}
class OpenRef : OpenMid<string> {
    public override void Accept((string, int) value) {}
}

class Payload {}
interface IPlain {
    void Read(Payload value);
}
class SeparateBranch : Base<int?>, IPlain {
    public void Read(Payload? value) {}
}
