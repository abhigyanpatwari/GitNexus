namespace Services;

using Contracts;

public class MyService : IAuditableService
{
    public string AuditTrail => "audit";

    public void BaseMethod() { }
    public void FooMethod() { }
    public void BarMethod() { }
}
