public class App
{
    public void CrossFileById()
    {
        DbLookup db = new DbLookup();
        db.Find(42);
    }

    public void CrossFileByName()
    {
        DbLookup db = new DbLookup();
        db.Find("alice");
    }

    public void ChainIntToFormat()
    {
        DbLookup db = new DbLookup();
        Formatter fmt = new Formatter();
        string result = db.Find(42);
        fmt.Format(result);
    }

    public void ChainNameToFormat()
    {
        DbLookup db = new DbLookup();
        Formatter fmt = new Formatter();
        string result = db.Find("alice");
        fmt.Format(result);
    }
}
