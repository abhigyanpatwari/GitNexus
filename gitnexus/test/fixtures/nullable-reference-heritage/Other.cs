#nullable enable
namespace Other { public struct Item {} }

namespace Other {
    public class SameNameDecoy : Shared.Bridge { public void Check(Item item) {} }
}
