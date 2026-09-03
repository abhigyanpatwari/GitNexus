pub const Thing = struct {
    v: u32 = 0,
    pub fn make() Thing {
        return .{};
    }
    pub fn m(self: *Thing) u32 {
        return self.v;
    }
};
