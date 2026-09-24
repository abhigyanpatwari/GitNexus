const std = @import("std");
pub fn build(b: *std.Build) void {
    _ = b.addModule("geo", .{ .root_source_file = b.path("src/root.zig") });
}
