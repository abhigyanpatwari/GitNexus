// A FILE-STRUCT (Lightpanda `Page.zig` shape): the file has top-level fields,
// so it IS a struct named after the file — `Page` — and its top-level fns
// taking `self` are its methods. `const Page = @This();` is the idiomatic
// self-alias, not a second declaration.
const std = @import("std");
const Page = @This();
const Session = @import("Session.zig");

session: *Session,
count: u32 = 0,

pub fn init(session: *Session) Page {
    return .{ .session = session };
}

pub fn getArena(self: *Page) u32 {
    return self.count;
}

pub fn bump(self: *Page) void {
    self.count += 1;
    _ = self.getArena();
}
<<<<<<< HEAD

// Field-typed receivers (F5): `session: *Session` types the member, so a
// call through it dispatches into Session.zig — directly (`self.session.name()`)
// or through a local alias of the field (`const s = self.session; s.name()`).
pub fn sessionName(self: *Page) []const u8 {
    return self.session.name();
}

pub fn sessionLabel(self: *Page) []const u8 {
    const s = self.session;
    return s.name();
}

||||||| parent of fb83c9d9 (fix(zig): type locals through try/catch/orelse, return types and payload captures)

=======

// F6 — value flow: a fallible constructor, member calls whose RETURN types
// type the local, optionals for `if` / `while` payloads.
pub fn make(session: *Session) !*Page {
    _ = session;
    return error.Nope;
}

pub fn getSession(self: *Page) *Session {
    return self.session;
}

pub fn maybeSession(self: *Page) ?*Session {
    return self.session;
}

>>>>>>> fb83c9d9 (fix(zig): type locals through try/catch/orelse, return types and payload captures)