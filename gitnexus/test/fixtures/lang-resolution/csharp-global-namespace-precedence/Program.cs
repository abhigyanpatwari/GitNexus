public class Program
{
    public static void Main(Voucher voucher)
    {
        // Outside any namespace: the global Voucher.
        voucher.Post();
    }
}
