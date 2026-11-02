package model

type Target struct { Value int }
type Container[Target any] struct { Item Target }
func generic[Target any](value Target) Target { return value }
func concrete(value Target) Target { return value }
func caller(value Target) Target { return concrete(value) }
const label = "Target"
// Target in the generic function names its own type parameter.
