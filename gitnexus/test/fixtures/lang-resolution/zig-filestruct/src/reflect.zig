// Lightpanda's `webapi/element/reflection.zig` shape (F8): a generic type
// constructor whose builder fns each declare a FUNCTION-LOCAL helper container
// named `R`. By binding name alone every `R` collapsed onto ONE `Struct:…:R`
// with one `R.get` / one `R.set`; each must be its own type
// (`Reflect.string$R`, `Reflect.url$R`) owning its own methods.
const std = @import("std");

pub const Accessor = struct {
    get: *const anyopaque,
    set: *const anyopaque,
};

pub fn Reflect(comptime T: type) type {
    return struct {
        pub fn string(comptime attr: []const u8) Accessor {
            const R = struct {
                fn get(self: *const T) []const u8 {
                    return readAttr(self, attr);
                }
                fn set(self: *T, value: []const u8) void {
                    writeAttr(self, attr, value);
                }
            };
            return Accessor{ .get = R.get, .set = R.set };
        }

        pub fn url(comptime attr: []const u8) Accessor {
            const R = struct {
                // A `@This()` alias inside a function-local container names
                // THAT container (`R`), not the enclosing type constructor:
                // `self: *const Self` below must dispatch `self.get()` to
                // `Reflect.url$R.get`.
                const Self = @This();
                fn get(self: *const T) []const u8 {
                    return normalize(readAttr(self, attr));
                }
                fn set(self: *T, value: []const u8) void {
                    writeAttr(self, attr, value);
                }
                fn check(self: *const Self) []const u8 {
                    return self.get();
                }
            };
            return Accessor{ .get = R.get, .set = R.set };
        }
    };
}

fn readAttr(self: anytype, attr: []const u8) []const u8 {
    _ = self;
    return attr;
}

fn writeAttr(self: anytype, attr: []const u8, value: []const u8) void {
    _ = self;
    _ = attr;
    _ = value;
}

fn normalize(s: []const u8) []const u8 {
    return s;
}
