public class Formatter
{
    public string Format(int value)
    {
        return value.ToString();
    }

    public string Format(string value)
    {
        return value.Trim();
    }
}
