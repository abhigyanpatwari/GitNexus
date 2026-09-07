const std = @import("std");
const main_mod = @import("./main.zig");

// C-ABI export: no `pub`, still the most externally visible symbol in the file.
export fn c_add(a: i32, b: i32) i32 {
    return a + b;
}

// Fieldless container: FFI handle type. May own methods, never fields.
pub const Handle = opaque {
    pub fn close(self: *Handle) void {
        _ = self;
    }
};

// Empty container body — tree-sitter-zig recovers it with a MISSING
// placeholder field; it must not become a nameless Property.
pub const Empty = struct {};

pub fn release(h: *Handle) void {
    h.close();
}

test "c_add adds" {
    _ = c_add(1, 2);
}

// The idiomatic layout: a test named after the function it exercises.
test "release" {
    var h: *Handle = undefined;
    release(h);
}

test {
    _ = c_add(3, 4);
}
