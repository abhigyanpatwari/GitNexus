const Worker = struct {
    pub fn process(self: Worker) void { _ = self; }
    pub fn dispatch(self: Worker) void { self.process(); }
};
const Other = struct { pub fn process(self: Other) void { _ = self; } };
fn caller(worker: Worker, other: Other) void { worker.process(); worker.dispatch(); other.process(); }
