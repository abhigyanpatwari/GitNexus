// Resolving this through a repo-wide module map would reach
// `packages/core/src/root.zig` — a package `tool` does not depend on.
const core = @import("core");

pub fn measure(attempt: u8) u8 {
    return core.retryBudget(attempt);
}
