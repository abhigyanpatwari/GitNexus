const std = @import("std");
const a = @import("a.zig");
const b = @import("b.zig");
const c = @import("c.zig");
const d = @import("d.zig");

// A same-named local type, so an external literal below has a tempting
// same-tail candidate in THIS file as well as in d.zig.
const Mutex = struct {
    held: bool = false,
};

fn useA() a.Thing {
    return a.Thing{ .a = 1 };
}

fn useB() b.Thing {
    return b.Thing{ .b = 2 };
}

fn useMissing() void {
    // `c.zig` defines no `Thing`: this must not bind to a.zig's or b.zig's.
    _ = c.Thing{};
}

fn useExternal() void {
    // `std` is external: neither the local `Mutex` nor d.zig's may answer.
    _ = std.Thread.Mutex{};
    _ = std.mem.Allocator{ .ptr = undefined, .vtable = undefined };
}

fn useLocal() void {
    _ = Mutex{};
    _ = d.Mutex{};
}

pub fn main() void {
    _ = useA();
    _ = useB();
    useMissing();
    useExternal();
    useLocal();
}
