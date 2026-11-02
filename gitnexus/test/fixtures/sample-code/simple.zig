const std = @import("std");

pub fn add(a: i32, b: i32) i32 {
    return a + b;
}

fn private_helper() i32 {
    return 0;
}

pub const Point = struct {
    x: i32,
    y: i32,

    pub fn init(x: i32, y: i32) Point {
        return .{ .x = x, .y = y };
    }

    pub fn distance(self: Point, other: Point) i32 {
        return (self.x - other.x) + (self.y - other.y);
    }
};

const Color = enum { red, green, blue };

pub fn main() void {
    const p = Point.init(1, 2);
    _ = p.distance(Point{ .x = 3, .y = 4 });
    _ = add(1, 2);
}

// C-ABI export (no `pub`), an opaque FFI handle, and test blocks.
export fn c_add(a: i32, b: i32) i32 {
    return a + b;
}

pub const Handle = opaque {
    pub fn close(self: *Handle) void {
        _ = self;
    }
};

test "add works" {
    _ = add(1, 2);
}

test {
    _ = c_add(1, 2);
}
