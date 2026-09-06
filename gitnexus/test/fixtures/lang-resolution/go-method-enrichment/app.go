// This fixture exercises method enrichment and a valid same-package free call.
// A different package with a normal import cannot refer to Dog or Classify bare.
package animal

func main() {
	dog := Dog{}
	sound := dog.Speak()
	category := Classify("dog")
	_, _ = sound, category
}
