n: u32 = 0,
pub const Inner = struct {
    pub fn m(self: Inner) void {
        _ = self;
    }
};
pub fn touch(self: *Host) void {
    _ = self;
}
const Host = @This();
