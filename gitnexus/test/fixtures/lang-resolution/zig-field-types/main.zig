pub const Address = struct {
    city: u32,

    pub fn save(self: Address) void {
        _ = self;
    }
};

pub const User = struct {
    address: Address,
};

pub const Http = struct {
    pub const Request = struct {
        value: u32,

        pub fn init() Request {
            return .{ .value = 1 };
        }
    };
};

pub fn processUser(user: User) void {
    _ = user.address.city;
    user.address.save();
}
