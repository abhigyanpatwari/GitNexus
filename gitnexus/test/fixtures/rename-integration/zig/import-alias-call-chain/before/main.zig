const invoke = @import("service.zig").process;
const service = @import("service.zig");
pub fn main() void { _ = invoke(1); _ = service.entry(2); }
