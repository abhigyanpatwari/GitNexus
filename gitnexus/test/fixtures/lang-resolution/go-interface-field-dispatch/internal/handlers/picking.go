package handlers

import "github.com/example/wms/internal/repository"

type PickHandlers struct {
	repo repository.OrderRepository
}

func (h *PickHandlers) Queue(id string) ([]string, error) {
	return h.repo.GetPickQueue(id)
}

func (h *PickHandlers) Unsplit(id string) error {
	return h.repo.UnsplitOrder(id)
}
