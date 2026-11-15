package main

import "example.com/renamefixture/api"

type derived struct{ api.Base }

func use(value derived) int { return value.Run() }

func main() { _ = use(derived{}) }
