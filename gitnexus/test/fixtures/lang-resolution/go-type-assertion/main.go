package main

func process(s Saver) {
	user := s.(User)
	user.Save()
	user.Greet()
}
