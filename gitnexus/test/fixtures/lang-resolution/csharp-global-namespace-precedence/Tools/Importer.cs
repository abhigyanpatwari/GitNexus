using Billing;

public class Importer
{
    public void Import(Voucher voucher)
    {
        // The global namespace's own types are searched before the
        // compilation unit's using directives, so this is the global Voucher.
        voucher.Post();
    }
}
