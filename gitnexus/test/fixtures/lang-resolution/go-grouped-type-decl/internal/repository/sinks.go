package repository

type AuditWriter struct {
	path string
}

func (w *AuditWriter) LogAudit(msg string) error { return nil }

type MetricWriter struct {
	ns string
}

func (w *MetricWriter) Observe(name string) error { return nil }
