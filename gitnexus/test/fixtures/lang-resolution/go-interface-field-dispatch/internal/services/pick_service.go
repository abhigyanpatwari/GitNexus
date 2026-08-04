package services

import "github.com/example/wms/internal/repository"

// PickService holds BOTH an interface-typed field and concrete-typed fields,
// so one fixture covers the failing case and its control.
type PickService struct {
	orderRepo repository.OrderRepository
	cartRepo  *repository.CartRepo
	auditRepo *repository.AuditRepo
}

func (s *PickService) GetPickQueue(id string) ([]string, error) {
	s.auditRepo.LogAuditEventAsync("pick")
	return s.orderRepo.GetPickQueue(id)
}

func (s *PickService) StartSession(id string) error {
	_ = s.cartRepo.Get(id)
	return s.orderRepo.DeleteItem(id)
}
