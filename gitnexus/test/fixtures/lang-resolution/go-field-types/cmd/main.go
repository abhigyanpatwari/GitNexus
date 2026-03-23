package main

import "example.com/go-field-types/models"

func processUser(user models.User) {
	// Field-access chain: user.Address → Address, then .Save() → Address#Save
	user.Address.Save()
}
