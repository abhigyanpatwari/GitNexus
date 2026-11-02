package main

import "example.com/renamefixture/api"

func read() string {
	config := api.NewConfig()
	return config.Name
}

func main() { _ = read() }
