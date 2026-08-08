package repository

// OrderRepository is the interface held as a struct FIELD by every service in
// this fixture. Pointer-receiver implementors only (#2813 shape).
type OrderRepository interface {
	DeleteItem(id string) error
	GetPickQueue(id string) ([]string, error)
}

// Grouped INTERFACE declaration — the same `type (...)` collapse that hits
// structs also hits interfaces, so both are pinned here (#2837).
type (
	AuditSink interface {
		LogAudit(msg string) error
	}

	MetricSink interface {
		Observe(name string) error
	}
)
