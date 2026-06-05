package main

// Fixture for issue #77: anonymous/local struct fields inside a function body
// must NOT be attributed as HAS_PROPERTY of the enclosing receiver struct.

type UserService struct{}

// UserHandler has exactly ONE real field: service.
type UserHandler struct {
	service *UserService
}

// CreateUser declares a LOCAL anonymous struct. Its Name/Email fields belong
// to that inline struct literal, not to UserHandler.
func (h *UserHandler) CreateUser() {
	var input struct {
		Name  string
		Email string
	}
	_ = input
}
