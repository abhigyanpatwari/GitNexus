public record Pair(int First)
{
    public int First { get; init; } = First;
}

public class Maker
{
    public Pair Make() { return new Pair(First: 1); }
}
