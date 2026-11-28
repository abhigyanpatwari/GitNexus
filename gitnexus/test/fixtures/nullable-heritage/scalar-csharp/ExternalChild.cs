#nullable enable
using Same = System.Timers.Timer;
class AmbiguousAlias : ExternalParent { public void M(Same? value) {} }
