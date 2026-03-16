// Tests assignment chain + is-pattern in the same file.
// The is-pattern (obj is User u) creates a Tier 0 binding;
// the assignment chain (var alias = u) propagates it via Tier 2.
// Also verifies that the type guard in extractPendingAssignment
// correctly skips is_pattern_expression nodes without breaking.
public class App
{
    public static void ProcessWithChain()
    {
        User u = new User();
        var alias = u;
        alias.Save();
    }

    public static void ProcessWithPattern(object obj)
    {
        if (obj is User u)
        {
            u.Save();
        }
    }

    public static void ProcessRepoChain()
    {
        Repo r = new Repo();
        var alias = r;
        alias.Save();
    }
}
