const std = @import("std");
const Page = @import("Page.zig");
const Session = @import("Session.zig");
const Sighandler = @import("Sighandler.zig");
const util = @import("util.zig");

pub fn main() void {
    var s = Session{ .label = "x" };
    // namespace-member (static) call — must keep working alongside the type
    var p = Page.init(&s);
    // receiver typed by the call-return rule (`Page.init` → `Page`)
    p.bump();
    _ = p.getArena();
    _ = s.findFrame(&p);
    // receiver typed by annotation
    var q: Page = undefined;
    _ = q.getArena();
    var h: Sighandler = .{};
    h.arm();
    _ = util.helper();
    useParam(&p);
}

fn useParam(page: *Page) void {
    _ = page.getArena();
}
