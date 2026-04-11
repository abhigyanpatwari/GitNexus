namespace Contracts;

public interface IAuditableService : IFooService, IBarService
{
    string AuditTrail { get; }
}
