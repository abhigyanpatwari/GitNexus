const PRNG = @This();
state: u64 = 0,
pub fn from_seed(seed: u64) PRNG {
    return .{ .state = seed };
}
pub fn next(prng: *PRNG) u64 {
    prng.state += 1;
    return prng.state;
}
