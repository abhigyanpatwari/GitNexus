// File-struct whose `@This()` alias is spelled DIFFERENTLY from the file stem
// (Lightpanda `Sighandler.zig` / `const SigHandler = @This();`). The type is
// still `Sighandler` (what importers write, what `@typeName` says); the alias
// is a second name for it inside the file, so `self: *SigHandler` must
// resolve to the same Struct.
const SigHandler = @This();

armed: bool = false,

pub fn arm(self: *SigHandler) void {
    self.armed = true;
    self.check();
}

fn check(self: *SigHandler) void {
    _ = self;
}
