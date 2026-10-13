package main

import "example.com/renamefixture/api"

func run(value int) int { return api.Other(value) }

func main() { _ = run(1) }
