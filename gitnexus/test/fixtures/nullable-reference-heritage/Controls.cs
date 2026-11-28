#nullable enable
namespace Shared { public partial class Item {} }
namespace Shared {
    public class Contract<T> { public virtual void Check(T item) {} }
    public class Bridge : Contract<Item?> {}
    public class AnnotatedContract<T> { public virtual void Check(Item? item) {} }
    public class Shadow<Item> : AnnotatedContract<int?> { public void Check(Item item) {} }
}