const Worker = struct {
    pub fn target(self: Worker) void { _ = self; }
};
fn caller(worker: Worker) void { worker.target(); }
comptime {
    if (@hasDecl(Worker, "renamed")) @compileError("Worker.renamed must stay undeclared");
}
