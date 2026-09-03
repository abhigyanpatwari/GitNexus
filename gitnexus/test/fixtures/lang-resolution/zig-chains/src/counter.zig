pub const Counter = struct {
    n: u32 = 0,
    pub fn init(n: u32) Counter {
        return .{ .n = n };
    }
    pub fn get(self: Counter) u32 {
        return self.n;
    }
};
