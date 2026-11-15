package main

import "example.com/renamefixture/api"

func run(value int) int {
	service := api.NewService()
	return service.Run(value)
}

func main() { _ = run(1) }
