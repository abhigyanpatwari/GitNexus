const std = @import("std");

// No build.zig.zon at all: the only bare-name module this repo can import is
// the one its own build.zig declares — here through a createModule binding
// that addImport later names "core".
pub fn build(b: *std.Build) void {
    const core_mod = b.createModule(.{
        .root_source_file = b.path("src/core.zig"),
        .target = b.standardTargetOptions(.{}),
    });
    const exe = b.addExecutable(.{
        .name = "app",
        .root_module = b.createModule(.{ .root_source_file = b.path("src/main.zig") }),
    });
    exe.root_module.addImport("core", core_mod);
    b.installArtifact(exe);
}
