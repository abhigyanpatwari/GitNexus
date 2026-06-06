// WI-H85 fixture (issue #85): UserService struct that satisfies
// IUserService from interfaces/service_interface.go. Both methods
// use pointer receivers — they live in the method set of *UserService.
package services

type UserService struct {
	users []map[string]interface{}
}

func (s *UserService) GetUsers() []map[string]interface{} {
	return s.users
}

func (s *UserService) CreateUser(name string, email string) map[string]interface{} {
	return map[string]interface{}{"name": name, "email": email}
}

// M3: UserNotifier struct that satisfies BOTH IUserService (from
// service_interface.go) AND INotificationService (from
// notification_interface.go). The cross-file detector must emit TWO
// distinct IMPLEMENTS edges — one per interface, in different files.
type UserNotifier struct {
	users []map[string]interface{}
}

func (n *UserNotifier) GetUsers() []map[string]interface{} {
	return n.users
}

func (n *UserNotifier) CreateUser(name string, email string) map[string]interface{} {
	return map[string]interface{}{"name": name, "email": email}
}

func (n *UserNotifier) Send(to string, body string) error {
	return nil
}

func (n *UserNotifier) Broadcast(body string) int {
	return 0
}
