namespace Audit
{
    using Billing;

    public class Checker
    {
        public void Check(Voucher voucher)
        {
            // A using directive inside a namespace declaration is consulted at
            // that namespace's level, before the global namespace.
            voucher.Post();
        }
    }
}
