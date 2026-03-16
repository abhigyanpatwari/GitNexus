package main

import (
	. "example.com/go-calls/internal/onearg"
	_ "example.com/go-calls/internal/zeroarg"
)

func main() {
	_ = WriteAudit("hello")
}
