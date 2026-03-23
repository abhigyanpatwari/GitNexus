package main

import "example.com/for-call-expr/models"

func processUsers() {
	for _, user := range models.GetUsers() {
		user.Save()
	}
}

func processRepos() {
	for _, repo := range models.GetRepos() {
		repo.Save()
	}
}

func main() {}
