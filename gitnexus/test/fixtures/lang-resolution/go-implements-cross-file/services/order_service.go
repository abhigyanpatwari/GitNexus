// WI-H85 fixture (issue #85): OrderService struct that satisfies
// IOrderService from interfaces/service_interface.go. Exercises
// multiple cross-file matches in a single fixture.
package services

type OrderService struct {
	orders map[int]map[string]interface{}
}

func (s *OrderService) GetOrder(id int) *map[string]interface{} {
	o, ok := s.orders[id]
	if !ok {
		return nil
	}
	return &o
}

func (s *OrderService) DeleteOrder(id int) bool {
	if _, ok := s.orders[id]; !ok {
		return false
	}
	delete(s.orders, id)
	return true
}
