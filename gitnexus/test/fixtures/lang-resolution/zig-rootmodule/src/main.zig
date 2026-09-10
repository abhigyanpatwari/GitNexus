// Bare-name import of the repo's own module, declared only in build.zig
// (no build.zig.zon anywhere).
const core = @import("core");

pub fn main() void {
    core.start();
}
