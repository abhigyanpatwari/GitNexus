pub const A = struct {
    pub const Item = struct {
        pub fn run(self: Item) void {
            _ = self;
        }
    };
};
pub const B = struct {
    pub const Item = struct {
        pub fn run(self: Item) void {
            _ = self;
        }
    };
};
pub const Outer = struct {
    pub const Inner = struct {
        pub fn inner_m(self: Inner) void {
            _ = self;
        }
    };
};
