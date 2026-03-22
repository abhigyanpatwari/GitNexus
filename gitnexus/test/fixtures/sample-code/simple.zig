const std = @import("std");

pub const Config = struct {
    value: i32,

    pub fn init() Config {
        return .{ .value = 1 };
    }
};

pub const Kind = enum {
    alpha,
    beta,
};

pub const Payload = union(enum) {
    alpha: i32,
    beta: bool,
};

pub const FileHandle = opaque {};

pub fn main() void {
    std.debug.print("hello\\n", .{});
}

export fn add(a: i32, b: i32) i32 {
    return a + b;
}

test "config initializes" {
    try std.testing.expect(true);
}

test {
    const cfg: Config = .{ .value = add(1, 2) };
    _ = cfg.value;
}
