namespace Audit.Trail;

using Billing;

public class Recorder
{
    public void Record(Voucher voucher)
    {
        // A using after a file-scoped namespace belongs to that namespace.
        voucher.Post();
    }
}
