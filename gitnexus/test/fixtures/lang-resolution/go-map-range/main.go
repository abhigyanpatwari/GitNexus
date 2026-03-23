package main

import "models"

func processMap(userMap map[string]models.User) {
	for _, user := range userMap {
		user.Save()
	}
}
