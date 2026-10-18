const Leaf = struct { value: u8 };
const Branch = struct { leaf: Leaf };
const Root = struct { branch: Branch };
const Other = struct { value: u8 };
fn read(root: Root, other: Other) u8 { return root.branch.leaf.value + other.value; }
fn write(leaf: *Leaf) void { leaf.value = 3; }
// value must remain in this comment.
