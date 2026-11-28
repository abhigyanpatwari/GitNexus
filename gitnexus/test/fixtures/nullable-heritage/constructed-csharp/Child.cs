#nullable enable
using Same = Candidates.Item;
using Arg = System.Uri;
class ExternalAliasDecoy : ExternalAliasBridge { public void Check(Box<Arg> value) {} }
class SameIdentity : SameIdentityBridge { public override void Accept(Box<Same>? value) {} }
