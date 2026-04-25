namespace App;

public class Counters
{
    public static int Hits { get; set; }
    public static int Misses { get; set; }
}

public class Runner
{
    public void Touch()
    {
        Counters.Hits = 42;
        Counters.Misses = 7;
    }
}
