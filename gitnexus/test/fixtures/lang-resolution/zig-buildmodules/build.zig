const std = @import("std");

// Two executables that each bind the alias "config" to THEIR OWN config.zig —
// the ordinary multi-target layout. A single first-wins map of aliases sends
// tool/main.zig's `@import("config")` to app/config.zig.
pub fn build(b: *std.Build) void {
    const corelib = b.dependency("corelib", .{});

    const app_config = b.createModule(.{ .root_source_file = b.path("src/app/config.zig") });
    const tool_config = b.createModule(.{ .root_source_file = b.path("src/tool/config.zig") });

    const app = b.addExecutable(.{ .name = "app", .root_source_file = b.path("src/app/main.zig") });
    app.root_module.addImport("config", app_config);
    // A path dep's NAMED module (declared by libs/corelib/build.zig).
    app.root_module.addImport("api", corelib.module("core"));

    const tool_mod = b.createModule(.{
        .root_source_file = b.path("src/tool/main.zig"),
        .imports = &.{ .{ .name = "config", .module = tool_config } },
    });
    const tool = b.addExecutable(.{ .name = "tool", .root_module = tool_mod });
    b.installArtifact(app);
    b.installArtifact(tool);

    // Two modules rooted in ONE directory that disagree on "clash": a file of
    // that directory which is neither root cannot be attributed, and must
    // resolve nothing rather than the first declaration.
    const clash_a = b.createModule(.{ .root_source_file = b.path("src/shared/clash_a.zig") });
    const clash_b = b.createModule(.{ .root_source_file = b.path("src/shared/clash_b.zig") });
    const shared_a = b.addModule("shared_a", .{ .root_source_file = b.path("src/shared/a.zig") });
    shared_a.addImport("clash", clash_a);
    const shared_b = b.addModule("shared_b", .{ .root_source_file = b.path("src/shared/b.zig") });
    shared_b.addImport("clash", clash_b);
}
