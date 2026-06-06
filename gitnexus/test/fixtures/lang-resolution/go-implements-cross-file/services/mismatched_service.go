// WI-H85 fixture (issue #85, M3 negative case): MismatchedService declares
// only ONE of the two methods required by IInventoryService. The
// cross-file IMPLEMENTS detector must NOT emit an edge — a struct that
// is a method-set subset of an interface does not satisfy it.
package services

type MismatchedService struct {
	items map[string]int
}

// GetItem is present (matches IInventoryService.GetItem).
func (s *MismatchedService) GetItem(name string) (int, bool) {
	v, ok := s.items[name]
	return v, ok
}

// SetItem is intentionally MISSING — IInventoryService.SetItem has no
// implementation here. This is the negative-case struct.
