namespace Billing;

public class Service
{
    public static void Settle(Voucher voucher)
    {
        // Same namespace: Billing.Voucher hides the global Voucher.
        voucher.Post();
        voucher.Payee.Notify();
    }

    public static Voucher Open()
    {
        return new Voucher();
    }
}
