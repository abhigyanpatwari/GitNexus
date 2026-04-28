package animal

type Animal interface {
	Speak() string
}

type Dog struct{}

func (d Dog) Speak() string {
	return "woof"
}

func Classify(name string) string {
	return "mammal"
}
