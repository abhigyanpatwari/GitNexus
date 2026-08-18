const std = @import("std");
pub fn build(b: *std.Build) void {
    // Build-time options module: generated at build time, no source file in
    // the repo — `@import("build_config")` must stay unresolved.
    var opts = b.addOptions();
    opts.addOption([]const u8, "version", "0.1.0");

    // The package's OWN root module, imported by name from every other file
    // (Lightpanda shape: named via addModule, then re-imported into itself
    // to allow the circular `@import("idioms")`).
    const idioms_module = b.addModule("idioms", .{
        .root_source_file = b.path("src/idioms.zig"),
        .link_libc = true,
    });
    idioms_module.addImport("idioms", idioms_module); // allow circular "idioms" import
    idioms_module.addImport("build_config", opts.createModule());

    const geo = b.dependency("geo", .{});
    const exe = b.addExecutable(.{ .name = "idioms", .root_source_file = b.path("src/main.zig") });
    exe.root_module.addImport("geo", geo.module("geo"));
    exe.root_module.addImport("idioms", idioms_module);
    exe.root_module.addImport("build_config", opts.createModule());
    b.installArtifact(exe);
}
