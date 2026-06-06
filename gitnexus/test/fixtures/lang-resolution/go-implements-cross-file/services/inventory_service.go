// WI-H85 fixture (issue #85, M3 same-file pair): InventoryService
// lives in the same file as MismatchedService but also in the same
// package `services` as the IInventoryService interface — wait, the
// interface is in package `interfaces`, so this is a CROSS-file pair.
// Either way, the same-file detector (collectGoImplementsHeritage)
// cannot see the cross-file pair; the cross-file detector handles it.
// Its confidence must be 0.7 (cross-file-structural-match).
package services

type InventoryService struct {
	items map[string]int
}

func (s *InventoryService) GetItem(name string) (int, bool) {
	v, ok := s.items[name]
	return v, ok
}

func (s *InventoryService) SetItem(name string, qty int) {
	s.items[name] = qty
}
