public class Counter
{
    public int Count { get; set; }
    public Counter(int Count) { this.Count = Count; }
}

public class Maker
{
    public Counter Make() { return new Counter(Count: 1); }
}
