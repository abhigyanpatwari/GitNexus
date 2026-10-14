package main

/*
#include "api.h"
*/
import "C"

func call() int {
	return int(C.compute(1))
}
