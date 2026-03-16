package main

func main() {
	sl := make([]User, 0)
	sl[0].Save()

	m := make(map[string]User)
	m["key"].Greet()
}
