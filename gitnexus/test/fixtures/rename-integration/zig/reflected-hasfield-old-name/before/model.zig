const Worker = struct { target: u8 };
fn caller(worker: Worker) u8 { return worker.target; }
comptime {
    if (!@hasField(Worker, "target")) @compileError("Worker.target must stay a field");
}
