pub struct Leaf { pub amount: i32 }
pub struct Branch { pub leaf: Leaf }
pub struct Root { pub branch: Branch }
pub struct Other { pub value: i32 }
fn read(root: &Root, other: &Other) -> i32 {
    root.branch.leaf.amount + other.value
}
fn write(root: &mut Root, value: i32) {
    root.branch.leaf.amount = value;
}
const LABEL: &str = "value";
// value on Other and the parameter must remain unchanged.
