package main

import "example.com/renamefixture/api"

func run(value int) int { return api.Target(value) }

func main() { _ = run(1) }
