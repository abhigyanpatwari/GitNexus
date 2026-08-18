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
