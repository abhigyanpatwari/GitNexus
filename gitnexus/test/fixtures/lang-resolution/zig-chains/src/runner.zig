pub const Runner = struct {
    x: u32 = 0,
    pub fn run(self: *Runner, cb: *const fn () void) void {
        _ = self;
        cb();
    }
};
