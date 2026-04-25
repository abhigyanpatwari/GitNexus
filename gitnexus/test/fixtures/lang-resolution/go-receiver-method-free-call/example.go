package example

type Example struct{}

func (e *Example) Caller() {
	callee()
}
