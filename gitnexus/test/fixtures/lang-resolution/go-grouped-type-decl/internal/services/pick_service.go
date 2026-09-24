package services

import "github.com/example/grouped/internal/repository"

// THE #2837 SHAPE. Identical field shape to WaveService, declared SECOND in a
// grouped `type (...)` block.
//
// `@scope.class` is captured on the `type_declaration`, so this whole block is
// ONE Class scope owning both structs; `buildWorkspaceResolutionIndex` keeps
// only the FIRST class-like def per scope, so `PickService` gets no
// `classScopeByDefId` entry and every `s.orderRepo` call site here resolves to
// nothing.
//
// `Decoy.orderRepo` deliberately shares the field NAME with a DIFFERENT type:
// both structs' field typeBindings live in one name-keyed map while the scope
// is shared, so this also pins that PickService is not typed by Decoy's field.
type (
	Decoy struct {
		orderRepo *LocalThing
	}

	PickService struct {
		orderRepo repository.OrderRepository
	}
)

type LocalThing struct {
	n int
}

func (l *LocalThing) DeleteItem(id string) error { return nil }

func (s *PickService) Release(id string) error {
	return s.orderRepo.DeleteItem(id)
}
