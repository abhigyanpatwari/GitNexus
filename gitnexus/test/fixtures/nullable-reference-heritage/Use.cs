#nullable enable
using Shared;
namespace Consumer {
    public class AcrossFiles : Contract<Item?> { public override void Check(Item item) {} }
    public class ExternalDecoy : Contract<System.TimeSpan?> { public void Check(System.TimeSpan item) {} }
}
