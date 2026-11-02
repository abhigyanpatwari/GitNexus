// `core` is a PACKAGE dependency, declared by this package's build.zig.zon and
// wired in by its build.zig — not a relative path. Resolving it needs the
// package's own config, which lives two directories below the repo root.
const core = @import("core");
const util = @import("util.zig");

pub fn run(attempt: u8) u8 {
    return core.retryBudget(attempt);
}

pub fn configured() u8 {
    var cfg = core.Config{};
    return cfg.load();
}

pub fn delegated(attempt: u8) u8 {
    return util.clamp(attempt);
}
