const std = @import("std");

pub fn build(b: *std.Build) void {
    const core_dep = b.dependency("core", .{});
    const app = b.addModule("app", .{ .root_source_file = b.path("src/main.zig") });
    app.addImport("core", core_dep.module("core"));
}
