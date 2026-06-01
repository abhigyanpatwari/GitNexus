namespace Models;

public struct AuditStamp : Contracts.IAuditable, Contracts.Detail.IQualified
{
    public bool Save()
    {
        return true;
    }
}
