// Only reached through an inline receiver: `@import("dump.zig").root(…)`.
pub fn root(depth: u32) void {
    _ = depth;
}
