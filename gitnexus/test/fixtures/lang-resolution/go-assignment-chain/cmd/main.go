package main

import "example.com/go-assignment-chain/models"

func getUser() models.User {
	return models.User{}
}

func getRepo() models.Repo {
	return models.Repo{}
}

func processEntities() {
	var u models.User = getUser()
	alias := u
	alias.Save()

	var r models.Repo = getRepo()
	rAlias := r
	rAlias.Save()
}
