package main

import "fmt"

// ExportedFunction is a public function
func ExportedFunction(name string) string {
	return fmt.Sprintf("Hello, %s", name)
}

// unexportedFunction is a private function
func unexportedFunction() int {
	return 42
}

type UserService struct {
	Name string
}

func (s *UserService) GetName() string {
	return s.Name
}
