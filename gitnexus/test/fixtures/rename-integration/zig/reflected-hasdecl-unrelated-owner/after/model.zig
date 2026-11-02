const Worker = struct {
    pub fn renamed(self: Worker) void { _ = self; }
};
const Other = struct {
    pub fn target(self: Other) void { _ = self; }
};
fn caller(worker: Worker, other: Other) void { worker.renamed(); other.target(); }
comptime {
    if (!@hasDecl(Other, "target")) @compileError("Other.target must stay declared");
    if (@hasDecl(Other, "renamed")) @compileError("Other.renamed must stay undeclared");
}
