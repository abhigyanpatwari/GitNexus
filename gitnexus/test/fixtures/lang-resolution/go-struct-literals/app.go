package main

func processUser(name string) {
	user := User{Name: name}
	user.Save()
}
