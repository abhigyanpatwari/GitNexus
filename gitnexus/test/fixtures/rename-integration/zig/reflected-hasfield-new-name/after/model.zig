const Worker = struct { target: u8 };
fn caller(worker: Worker) u8 { return worker.target; }
comptime {
    if (@hasField(Worker, "renamed")) @compileError("Worker.renamed must stay absent");
}
