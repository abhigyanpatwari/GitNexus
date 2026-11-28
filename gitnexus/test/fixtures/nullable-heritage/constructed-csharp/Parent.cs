#nullable enable
using Known = Candidates.Item;
using Arg = System.Text.StringBuilder;
class Parent<T> { public virtual void Check(T value) {} }
class ExternalAliasBridge : Parent<Box<Arg>?> {}
class SameIdentityBridge : Mid<Box<Known>> {}
