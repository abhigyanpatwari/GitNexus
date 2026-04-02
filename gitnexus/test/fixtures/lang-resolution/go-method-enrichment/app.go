package main

import "animal"

func main() {
	dog := Dog{}
	sound := dog.Speak()
	category := Classify("dog")
}
