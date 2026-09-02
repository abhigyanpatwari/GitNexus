pub const Counter = struct {
    n: u32 = 0,
    // receiver named after the type, TigerBeetle style
    pub fn incr(counter: *Counter) void {
        counter.n += 1;
    }
    pub fn incr_self(self: *Counter) void {
        self.n += 1;
    }
    pub fn by_value(counter: Counter) u32 {
        return counter.n;
    }
};

pub fn Pool(comptime Node: type) type {
    return struct {
        free: ?*Node = null,
        // mach style: `pool: *@This()`
        pub fn release(pool: *@This(), node: *Node) void {
            _ = pool;
            _ = node;
        }
    };
}

pub const Op = enum(u8) {
    create = 1,
    lookup = 2,
    pub fn event_max(op: Op) u32 {
        return @intFromEnum(op);
    }
};
