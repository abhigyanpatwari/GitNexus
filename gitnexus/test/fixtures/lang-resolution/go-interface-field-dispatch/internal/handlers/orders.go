package handlers

import "github.com/example/wms/internal/repository"

type OrderHandlers struct {
	repo      repository.OrderRepository
	auditRepo *repository.AuditRepo
}

func (h *OrderHandlers) Delete(id string) error {
	h.auditRepo.LogAuditEventAsync("delete")
	return h.repo.DeleteItem(id)
}
