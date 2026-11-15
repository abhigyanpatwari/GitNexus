package main

import operations "example.com/renamefixture/api"

func middle(value int) int { return operations.Compute(value) }
func outer(value int) int { return middle(value) }
func shadow(Compute int) int { return Compute }
const label = "Compute"
// Compute must remain in this comment and the package alias is stable.
