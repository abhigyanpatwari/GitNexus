const Page = @This();

size: u32 = 0,

pub fn init() Page {
    return .{};
}

pub fn m(self: Page) u32 {
    return self.size;
}
