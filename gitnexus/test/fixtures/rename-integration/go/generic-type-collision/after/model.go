package model

type Target struct { Value int }
func generic[Element any](value Target, item Element) Target { return value }
