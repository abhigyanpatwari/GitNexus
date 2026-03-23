package main

import "example.com/go-deep-field-chain/models"

func processUser(user models.User) {
	// 2-level chain: user.Address → Address, then .Save() → Address#Save
	user.Address.Save()

	// 3-level chain: user.Address → Address, .City → City, .GetName() → City#GetName
	user.Address.City.GetName()
}
