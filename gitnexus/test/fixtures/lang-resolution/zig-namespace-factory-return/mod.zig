pub const C = struct {
    pub fn m(self: C) i32 {
        _ = self;
        return 1;
    }
};

pub const Other = struct {
    pub fn m(self: Other) i32 {
        _ = self;
        return 2;
    }
};

pub fn make() C {
    return C{};
}
