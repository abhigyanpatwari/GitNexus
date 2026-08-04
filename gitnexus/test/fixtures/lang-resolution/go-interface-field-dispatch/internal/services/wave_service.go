package services

import "github.com/example/wms/internal/repository"

// WaveService declares the SAME field shape as PickService — the issue
// reported these two behaving differently at scale (#2813).
type WaveService struct {
	orderRepo repository.OrderRepository
	auditRepo *repository.AuditRepo
}

func (s *WaveService) Release(id string) error {
	s.auditRepo.LogAuditEventAsync("wave")
	return s.orderRepo.DeleteItem(id)
}

func (s *WaveService) Queue(id string) ([]string, error) {
	return s.orderRepo.GetPickQueue(id)
}
