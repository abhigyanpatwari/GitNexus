package model

type Leaf struct { Value int }
type Branch struct { Leaf *Leaf }
type Root struct { Branch *Branch }
type Other struct { Value int }
func read(root *Root, other Other) int {
    return root.Branch.Leaf.Value + other.Value
}
func write(root *Root, Value int) {
    root.Branch.Leaf.Value = Value
}
const label = "Value"
// Value on Other and the parameter must remain unchanged.
