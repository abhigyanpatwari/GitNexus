package main

import "go-consumer-before-provider/models"

func main() {
	user := models.GetUser()
	user.Save()
}
