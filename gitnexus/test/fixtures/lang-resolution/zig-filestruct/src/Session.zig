const Session = @This();
const Page = @import("Page.zig");
label: []const u8,

pub fn name(self: *Session) []const u8 {
    return self.label;
}

pub fn findFrame(self: *Session, page: *Page) u32 {
    _ = self;
    // Method call on a parameter typed by ANOTHER file-struct.
    return page.getArena();
}

// F6 — an iterator-shaped method: `while (s.next()) |p| p.bump()`.
pub fn next(self: *Session) ?*Page {
    _ = self;
    return null;
}
