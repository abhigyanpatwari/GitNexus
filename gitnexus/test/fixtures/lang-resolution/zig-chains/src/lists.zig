pub fn List(comptime T: type) type {
    return struct {
        items: []T = &.{},
        pub fn push(self: *@This()) void {
            _ = self;
        }
    };
}
