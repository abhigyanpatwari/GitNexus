const std = @import("std");
const pioneer = @import("./pioneer.zig");

pub fn main() void {
    var p = pioneer.Pioneer{ .energy = 0 };
    p.tick();
    helper();
}

fn helper() void {
    _ = 1;
}
