package main

import "C"

func call() int {
	return int(C.compute(1))
}
