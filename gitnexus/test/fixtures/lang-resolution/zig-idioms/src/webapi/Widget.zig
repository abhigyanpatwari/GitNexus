// A file-as-struct whose `@This()` alias is spelled `Self`, NOT `Widget`.
//
// This is the ordinary Zig idiom, and the case #3219 originally declined. The
// container this file mints is named after the FILE STEM (`Widget`), so before
// `bindZigThisAliases` the name `Self` meant nothing class-like here: a
// file-level `@This()` alias mints no Const at all (`isZigFileThisAlias`
// suppresses it so it cannot shadow the type for `w: *Widget`), and a
// container-level one mints a Variable that every `isClassLike` walk steps
// over. Every qualified reference through the alias — a CALL as much as a
// REGISTRATION — resolved to nothing.
//
// Counted on the corpora on hand when this was fixed: 73 of ghostty's 185
// `@This()` files, 93 of tigerbeetle's 94 and 8 of mach's 42 spell the alias
// differently from the file stem, carrying 302 `Alias.member` references, 96
// of them calls.
//
// `Element.zig` next door is the OTHER half of the control: it writes
// `const Element = @This();` in `Element.zig`, so its qualified references
// resolved through the stem binding and must keep resolving exactly as before.
const Self = @This();

_w: u8 = 0,

pub fn width(self: *Self) u8 {
    return self._w;
}

// A qualified CALL through the alias — the explicit spelling Zig allows beside
// `self.width()`, and the shape `Alias.member` takes 96 times in the corpora
// above.
pub fn describeWidth(self: *Self) u8 {
    return Self.width(self);
}

pub const WidgetApi = struct {
    pub const binder = Binder(Self);
    // A qualified REGISTRATION through the alias: the #3399 shape, written the
    // way most Zig files spell their own type.
    pub const w = binder.accessor(Self.width, null, .{});
};

// A NESTED container with its own differently-spelled alias. The file-level and
// container-level aliases take different code paths — one binds at the module
// scope against the file-struct, the other at the container's own scope — so
// both are exercised.
pub const Metrics = struct {
    const Me = @This();

    _n: u8 = 0,

    pub fn read(self: *Me) u8 {
        return self._n;
    }

    pub fn readTwice(self: *Me) u8 {
        return Me.read(self) +% Me.read(self);
    }
};

fn Binder(comptime T: type) type {
    _ = T;
    return struct {
        pub fn accessor(comptime g: anytype, comptime s: anytype, comptime o: anytype) u8 {
            _ = g;
            _ = s;
            _ = o;
            return 0;
        }
    };
}
