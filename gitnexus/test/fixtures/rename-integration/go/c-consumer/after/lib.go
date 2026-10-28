package main

import "C"

//export compute
func compute(value C.int) C.int {
	return value
}

func main() {}
