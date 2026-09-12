const std = @import("std");
pub fn build(b: *std.Build) void {
    _ = b.addModule("core", .{ .root_source_file = b.path("src/core.zig") });
}
