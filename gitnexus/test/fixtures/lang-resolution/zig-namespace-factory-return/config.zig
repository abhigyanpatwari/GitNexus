port: u16 = 0,

const Self = @This();

pub fn init() Self {
    return .{};
}

pub fn listen(self: Self) u16 {
    return self.port;
}
