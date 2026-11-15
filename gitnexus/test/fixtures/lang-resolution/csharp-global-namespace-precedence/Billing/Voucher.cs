namespace Billing;

public class Voucher
{
    public Payee Payee { get; set; } = new Payee();

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
