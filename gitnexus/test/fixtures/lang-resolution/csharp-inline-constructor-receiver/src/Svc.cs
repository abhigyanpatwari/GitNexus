namespace App
{
    public class Svc
    {
        public int DoWork()
        {
            return 1;
        }
    }

    public class Other
    {
        public int DoWork()
        {
            return 2;
        }
    }

    public static class Factories
    {
        public static Other MakeOther()
        {
            return new Other();
        }
    }
}
