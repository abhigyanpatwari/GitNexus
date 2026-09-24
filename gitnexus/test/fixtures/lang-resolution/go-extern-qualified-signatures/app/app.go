package app

import (
	"context"

	"example.com/extqual/store"
)

type Handler struct {
	store store.Store
}

func (h *Handler) Remove(ctx context.Context, id string) error {
	return h.store.Delete(ctx, id)
}
