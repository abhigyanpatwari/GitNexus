const std = @import("std");
const Allocator = std.mem.Allocator;

pub const VERSION: []const u8 = "1.0";
pub var global_count: u32 = 0;
pub const Err = error{ Oops, Bad };

pub const Counter = struct {
    const Self = @This();
    count: u32 = 0,

    pub fn init() Self {
        return .{};
    }
    pub fn incr(self: *Self) void {
        self.count += 1;
    }
    pub fn get(self: *const @This()) u32 {
        return self.count;
    }
    pub fn twice(self: *Self) void {
        self.incr();
        self.incr();
    }
};

/// Generic type constructor — Zig's only spelling of a generic type.
pub fn Stack(comptime T: type) type {
    return struct {
        const Self = @This();
        items: []T = &.{},

        pub fn init() Self {
            return .{};
        }
        pub fn push(self: *Self, v: T) void {
            _ = self;
            _ = v;
        }
        pub fn top(self: Self) ?T {
            _ = self;
            return null;
        }
        pub fn clear(self: *Self) void {
            self.items = &.{};
        }
    };
}
