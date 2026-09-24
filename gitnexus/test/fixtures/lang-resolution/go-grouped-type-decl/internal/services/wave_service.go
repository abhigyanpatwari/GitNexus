package services

import "github.com/example/grouped/internal/repository"

// CONTROL: plain declaration. This struct is the only class-like def in its
// `type_declaration`, so it gets its own Class scope under either capture
// granularity and resolves today.
type WaveService struct {
	orderRepo repository.OrderRepository
}

func (s *WaveService) Release(id string) error {
	return s.orderRepo.DeleteItem(id)
}
