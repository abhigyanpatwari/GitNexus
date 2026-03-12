namespace VariadicProj.Utils
{
    public static class Logger
    {
        public static string Record(params string[] args)
        {
            return string.Join(", ", args);
        }
    }
}
