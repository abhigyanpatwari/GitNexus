public class DbLookup : ILookup
{
    public string Find(int id)
    {
        return "by-id";
    }

    public string Find(string name)
    {
        return "by-name";
    }
}
