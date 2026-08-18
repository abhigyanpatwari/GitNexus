const std = @import("std");
pub fn build(b: *std.Build) void {
    const geo = b.dependency("geo", .{});
    const exe = b.addExecutable(.{ .name = "idioms", .root_source_file = b.path("src/main.zig") });
    exe.root_module.addImport("geo", geo.module("geo"));
    b.installArtifact(exe);
}
