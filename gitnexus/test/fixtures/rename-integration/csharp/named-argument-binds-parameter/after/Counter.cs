public class Counter
{
    public int Total { get; set; }
    public Counter(int Count) { this.Total = Count; }
}

public class Maker
{
    public Counter Make() { return new Counter(Count: 1); }
}
