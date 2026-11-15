namespace Billing.Reports
{
    public class Summary
    {
        public void Print(Voucher voucher)
        {
            // Enclosing namespace: Billing is searched before the global namespace.
            voucher.Post();
        }
    }
}
