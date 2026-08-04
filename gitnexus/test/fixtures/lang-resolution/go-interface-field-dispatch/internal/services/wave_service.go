package services

import "github.com/example/wms/internal/repository"

// WaveService declares the SAME field shape as PickService — the issue
// reported these two behaving differently at scale (#2813).
type WaveService struct {
	orderRepo  repository.OrderRepository
	orderRepo2 *repository.OrderRepo
	auditRepo  *repository.AuditRepo
}

func (s *WaveService) Release(id string) error {
	s.auditRepo.LogAuditEventAsync("wave")
	return s.orderRepo.DeleteItem(id)
}

func (s *WaveService) Queue(id string) ([]string, error) {
	return s.orderRepo.GetPickQueue(id)
}

// Recount calls through a CONCRETE field whose own type (*OrderRepo) is itself
// an implementor of OrderRepository. This is the shape where the dispatch type
// gate is load-bearing: the call must resolve to OrderRepo only and must NOT
// fan out to the sibling implementor MockOrderRepo (#2829 review).
func (s *WaveService) Recount(id string) error {
	return s.orderRepo2.UnsplitOrder(id)
}
