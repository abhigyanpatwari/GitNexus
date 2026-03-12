package main

import "go-local-shadow/internal/utils"

func Save(data string) {
	println("local save")
}

func main() {
	Save("test")
	_ = utils.Save
}
