package repository

// AuditRepo and CartRepo are the CONCRETE-field controls: calls through a
// concrete-typed field already resolved before #2813 and must keep resolving
// to the implementation, with no interface-dispatch fan-out.
type AuditRepo struct{}

func (a *AuditRepo) LogAuditEventAsync(msg string) {}

type CartRepo struct{}

func (c *CartRepo) Get(id string) string { return "" }
