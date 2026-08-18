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
