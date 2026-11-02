package api

func 日本(value int) int { return value + 1 }

func Other(value int) int { return 日本(value) }
