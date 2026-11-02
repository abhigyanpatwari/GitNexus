// The package's own root module — what `@import("idioms")` means in-repo,
// per `b.addModule("idioms", …)` in build.zig.
pub const Arena = struct {
    used: usize = 0,

    pub fn reset(self: *Arena) void {
        self.used = 0;
    }
};

pub fn boot() void {}
