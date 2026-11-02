const Worker = struct {
    pub fn target(self: Worker) void { _ = self; }
};
fn caller(worker: Worker) void { worker.target(); }
comptime {
    if (!@hasDecl(Worker, "target")) @compileError("Worker.target must stay declared");
}
