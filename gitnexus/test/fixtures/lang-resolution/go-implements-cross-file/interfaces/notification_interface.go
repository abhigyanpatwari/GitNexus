// WI-H85 fixture (issue #85, M3 second-interface file): INotificationService
// lives in its OWN file so a struct can match an interface defined in
// `interfaces/service_interface.go` AND another interface defined in
// `interfaces/notification_interface.go`. This exercises "struct
// matching 2 interfaces in different files → 2 IMPLEMENTS edges".
package interfaces

type INotificationService interface {
	Send(to string, body string) error
	Broadcast(body string) int
}
