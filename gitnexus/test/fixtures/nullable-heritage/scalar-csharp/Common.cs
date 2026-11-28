#nullable enable
using System.Threading;
class Open<T> {
 public virtual void Same(CancellationToken token) {}
 public virtual void Qualified(System.Threading.CancellationToken token) {}
 public virtual void Rooted(global::System.Threading.CancellationToken token) {}
}
class Through<T> : Open<T?> where T : class {}
class Standard : Through<string> {
 public override void Same(CancellationToken token) {}
 public override void Qualified(System.Threading.CancellationToken token) {}
 public override void Rooted(global::System.Threading.CancellationToken token) {}
}
class OrdinaryBase { public virtual void Direct(CancellationToken token) {} }
class Ordinary : OrdinaryBase { public override void Direct(CancellationToken token) {} }
