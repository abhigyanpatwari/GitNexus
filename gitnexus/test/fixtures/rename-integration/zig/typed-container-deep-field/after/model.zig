const Leaf = struct { count: u8 };
const Branch = struct { leaf: Leaf };
const Root = struct { branch: Branch };
const Other = struct { value: u8 };
fn read(root: Root, other: Other) u8 { return root.branch.leaf.count + other.value; }
fn write(leaf: *Leaf) void { leaf.count = 3; }
// value must remain in this comment.
