package services

import "github.com/example/grouped/internal/repository"

// ORDER CONTROL: same grouped shape as pick_service.go, but the service struct
// is declared FIRST. If only this one resolves, the fix is order-luck, not a
// fix (#2837).
type (
	SortService struct {
		orderRepo repository.OrderRepository
	}

	SortDecoy struct {
		orderRepo *LocalThing
	}
)

func (s *SortService) Release(id string) error {
	return s.orderRepo.DeleteItem(id)
}
