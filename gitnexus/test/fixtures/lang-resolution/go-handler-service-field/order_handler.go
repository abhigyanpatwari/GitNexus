package main

// OrderHandler delegates to an OrderService via a struct field.
type OrderHandler struct {
	service *OrderService
}

// GetOrder must resolve h.service.GetOrder() to OrderService.GetOrder
// (in order_service.go), NOT to OrderHandler.GetOrder (self-reference). Issue #19.
func (h *OrderHandler) GetOrder() string {
	return h.service.GetOrder()
}
