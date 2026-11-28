package decorator

// The decorator shape from #2836: loggingRepo implements Repository and holds
// its delegate in a Repository-typed field.
type Repository interface {
	DeleteItem(id string) error
	Count() int
}

type SqlRepo struct{ dsn string }

func (s *SqlRepo) DeleteItem(id string) error { return nil }

func (s *SqlRepo) Count() int { return 0 }

type loggingRepo struct{ next Repository }

func (l *loggingRepo) DeleteItem(id string) error {
	l.next.Count()
	return l.next.DeleteItem(id)
}

func (l *loggingRepo) Count() int { return l.next.Count() }

// Service is the control: a caller that is not itself an implementation keeps
// the whole fan-out.
type Service struct{ repo Repository }

func (s *Service) Run(id string) error { return s.repo.DeleteItem(id) }
