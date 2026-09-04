// A NAMESPACE file exporting a generic type constructor (`List(u8)`) and the
// Lightpanda `js.Bridge(T)` shape: a type constructor that FORWARDS to
// another one (`return Builder(T);`) instead of returning a container.
pub const Thing = struct {
    pub fn make() Thing {
        return .{};
    }
    pub fn run(self: *Thing) void {
        _ = self;
    }
};

pub fn List(comptime T: type) type {
    return struct {
        items: []T = &.{},
        pub fn init() @This() {
            return .{};
        }
        pub fn push(self: *@This(), v: T) void {
            _ = self;
            _ = v;
        }
    };
}

pub fn Bridge(comptime T: type) type {
    return Builder(T);
}

pub fn Builder(comptime T: type) type {
    return struct {
        pub fn accessor(comptime name: []const u8) void {
            _ = name;
            _ = T;
        }
        pub fn prototypeChain() void {}
    };
}
