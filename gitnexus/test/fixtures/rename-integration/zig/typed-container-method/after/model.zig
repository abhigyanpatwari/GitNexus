const Worker = struct {
    pub fn execute(self: Worker) void { _ = self; }
    pub fn dispatch(self: Worker) void { self.execute(); }
};
const Other = struct { pub fn process(self: Other) void { _ = self; } };
fn caller(worker: Worker, other: Other) void { worker.execute(); worker.dispatch(); other.process(); }
