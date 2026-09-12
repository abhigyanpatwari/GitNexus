pub const Op = enum(u8) {
    create = 1,
    lookup = 2,
    pub fn event_max(self: Op) u32 {
        return @intFromEnum(self);
    }
};
