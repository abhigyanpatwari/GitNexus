namespace Billing;

public class Voucher
{
    public Payee Payee { get; set; }

    public void Post()
    {
    }

    public static Voucher Create()
    {
        return new Voucher();
    }
}

public class Payee
{
    public void Notify()
    {
    }
}
