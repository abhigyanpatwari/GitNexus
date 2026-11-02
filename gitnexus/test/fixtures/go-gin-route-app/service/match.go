package service

type Service struct{}

func (s *Service) UnfinalizeRound(seasonID, roundID string) {
	s.reopen(roundID)
}

func (s *Service) reopen(roundID string) {
	audit(roundID)
}

func audit(id string) {}
