package main

import "C"

// point and vector remain comments.
func other() C.struct_other {
	var value C.struct_other
	_ = "point vector"
	return value
}
