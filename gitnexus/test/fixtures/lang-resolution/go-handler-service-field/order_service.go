package main

// OrderService owns the GetOrder business logic.
type OrderService struct{}

func (s *OrderService) GetOrder() string {
	return "order"
}
