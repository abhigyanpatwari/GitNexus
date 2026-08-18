// Type aliases (review finding F7). `const X = <type expr>;` is Zig's only
// alias syntax; every one of these is a Const in the graph, and every receiver
// below is typed THROUGH the alias. Lightpanda: `pub const Proto = HtmlElement;`,
// `const Allocator = std.mem.Allocator;`, `pub const bridge = js.Bridge(T);`.
const generic = @import("generic.zig");
const Page = @import("Page.zig");
const Thing = generic.Thing;

const Local = struct {
    pub fn mk() Local {
        return .{};
    }
    pub fn go(self: *Local) void {
        _ = self;
    }
};

// b1/b2 — alias of a same-file struct
const LocalAlias = Local;
// b3/b4 — alias of an alias (the promoted namespace-member import `Thing`)
const T2 = Thing;
// b5..b7 — alias of an INSTANTIATED generic type constructor
const B = generic.List(u8);
// alias of a namespace import that is also a file-struct type
const P = Page;
// a value const and a value call: NOT type aliases
const max = 5;
const helperResult = generic.Thing.make();

fn b1() void {
    _ = LocalAlias.mk();
}
fn b2() void {
    var l = LocalAlias.mk();
    l.go();
}
fn b3() void {
    _ = T2.make();
}
fn b4() void {
    var t = T2.make();
    t.run();
}
fn b5() void {
    _ = B.init();
}
fn b6() void {
    var b = B{};
    b.push(1);
}
fn b7() void {
    var x: B = .{};
    x.push(2);
}
// b8 — the same alias inside a fn body (Lightpanda `const R = …;` locals)
fn b8() void {
    const R = generic.List(u16);
    var r = R.init();
    r.push(3);
}
fn b10() void {
    var q: P = undefined;
    _ = q.getArena();
}
// b11 — a VALUE alias (`var cur = orig;`, the cursor idiom) is Rust's
// `let x = y`: the same binding, chained to the parameter's type.
fn b11(orig: *Local) void {
    var cur = orig;
    cur.go();
}

// b9 — Lightpanda's `JsApi` shape: a container-level alias of a forwarding
// type constructor, used by every member declaration of the container.
pub const JsApi = struct {
    pub const bridge = generic.Bridge(Local);
    pub const Meta = struct {
        pub const prototype_chain = bridge.prototypeChain();
    };
    pub const value = bridge.accessor("value");
};

pub fn main() void {
    _ = max;
    _ = helperResult;
}
