package main

import "go-cross-file/models"

func main() {
	user := models.GetUser()
	user.Save()
	user.GetName()
}
