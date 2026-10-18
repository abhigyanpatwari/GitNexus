package main

import "example.com/renamefixture/api"

func run(value int) int { return api.Ünicode(value) }

func main() { _ = run(1) }
