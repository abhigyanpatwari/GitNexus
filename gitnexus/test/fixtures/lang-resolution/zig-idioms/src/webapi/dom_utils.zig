// A NAMESPACE-only module: no `const X = @This()`, so this file declares no
// container symbol of its own. Its members are reachable only through an
// `@import` handle — the second kind of owner a qualified name can have, and
// the one `findClassBindingInScope` cannot answer for.
//
// Lightpanda's `libdom.zig` / `parser.zig` helpers are written exactly this
// way, and they are registered into the same bridge tables as the file-struct
// methods next door.

pub const DEFAULT_NS: u8 = 7;

pub fn compare(a: u8, b: u8) u8 {
    return if (a > b) a else b;
}

pub fn normalize(v: u8) u8 {
    return v;
}

// Republished by `hub.zig`, and by nothing else — so an assertion about the
// hub cannot be satisfied by an edge some other case emitted.
pub fn scale(v: u8) u8 {
    return v +% 1;
}
