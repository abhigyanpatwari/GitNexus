const PRNG = @This();
state: u64 = 0,
pub fn from_seed(seed: u64) PRNG {
    return .{ .state = seed };
}
pub fn next(self: *PRNG) u64 {
    self.state += 1;
    return self.state;
}
