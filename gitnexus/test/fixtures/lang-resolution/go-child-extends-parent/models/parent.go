package models

type Parent struct{}

func (p *Parent) ParentMethod() string {
	return "parent"
}
