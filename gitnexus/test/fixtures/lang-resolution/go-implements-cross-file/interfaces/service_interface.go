// WI-H85 fixture (issue #85): Go interface defined in one file,
// implementations defined in another file. The cross-file IMPLEMENTS
// edge must be emitted at confidence 0.7 (lower than same-file 1.0).
//
// M3 extension: also defines IInventoryService (2 methods) so the
// fixture can exercise the subset/negative case (MismatchedService has
// only 1 method → no edge) and the same-file pair (InventoryService in
// services/ satisfies IInventoryService in the same file).
package interfaces

type IUserService interface {
	GetUsers() []map[string]interface{}
	CreateUser(name string, email string) map[string]interface{}
}

type IOrderService interface {
	GetOrder(id int) *map[string]interface{}
	DeleteOrder(id int) bool
}

type IInventoryService interface {
	GetItem(name string) (int, bool)
	SetItem(name string, qty int)
}
