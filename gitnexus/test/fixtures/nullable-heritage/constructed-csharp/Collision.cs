#nullable enable
namespace Candidates {
    class Item {}
    class Bridge : Mid<Box<Item>> {}
}
namespace Others {
    class Item {}
    class SameNameDecoy : Candidates.Bridge { public void Accept(Box<Item> value) {} }
}
