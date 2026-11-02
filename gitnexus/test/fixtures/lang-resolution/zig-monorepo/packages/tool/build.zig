const std = @import("std");

pub fn build(b: *std.Build) void {
    const tool = b.addModule("tool", .{ .root_source_file = b.path("src/main.zig") });
    // The SAME alias as `app` binds, pointing somewhere else entirely.
    const own_core = b.createModule(.{ .root_source_file = b.path("src/core.zig") });
    tool.addImport("core", own_core);
}
