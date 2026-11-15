const Worker = struct { target: u8 };
const Other = struct { target: u8 };
fn caller(worker: Worker, other: Other) u8 { return worker.target + other.target; }
comptime {
    if (!@hasField(Other, "target")) @compileError("Other.target must stay a field");
    if (@hasField(Other, "renamed")) @compileError("Other.renamed must stay absent");
}
