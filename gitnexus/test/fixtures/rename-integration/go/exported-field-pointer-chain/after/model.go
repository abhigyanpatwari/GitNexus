package model

type Leaf struct { Amount int }
type Branch struct { Leaf *Leaf }
type Root struct { Branch *Branch }
type Other struct { Value int }
func read(root *Root, other Other) int {
    return root.Branch.Leaf.Amount + other.Value
}
func write(root *Root, Value int) {
    root.Branch.Leaf.Amount = Value
}
const label = "Value"
// Value on Other and the parameter must remain unchanged.
