pub const Thing = struct {
    pub fn sub_m(self: Thing) void {
        _ = self;
    }
    pub fn make() Thing {
        return .{};
    }
};
