const std = @import("std");
const counter = @import("counter.zig");
// Alias of a namespace member — the most common way to bring a type into scope.
const Counter = counter.Counter;
// Single-member import straight off @import.
const Stack = @import("counter.zig").Stack;
// build.zig.zon path deps: geo declares src/root.zig in its build.zig,
// oldlib has no build.zig and relies on the src/<name>.zig convention.
const geo = @import("geo");
const oldlib = @import("oldlib");
// The package's OWN root module, named by build.zig's addModule("idioms", …)
// (Lightpanda: `const lp = @import("lightpanda");` in 378 of 567 files).
const idioms = @import("idioms");
// Generated at build time (addOptions().createModule()) — no in-repo file.
const build_config = @import("build_config");
// Removed from the language in 0.15, still everywhere in 0.11–0.14 code.
pub usingnamespace @import("mixin.zig");
// @import in EXPRESSION position — the JS-API registration table idiom
// (Lightpanda's bridge.zig lists ~290 modules this way). No name is bound;
// each element is still a file dependency.
pub const Interfaces = .{
    @import("webapi/AbortController.zig"),
    @import("webapi/AbortSignal.zig"),
};

pub fn main() void {
    // call-return inference: the receiver of the constructor call names the type
    var a = Counter.init();
    a.incr();
    // annotation-only binding — `= undefined` and 0.14+ decl literals `.init` / `.empty`
    var b: Counter = undefined;
    b.twice();
    const c: Counter = .init();
    _ = c.get();
    // struct-literal constructor through the alias
    const d = Counter{};
    _ = d.get();
    // generic instantiation: literal, static call on the instantiation, annotation
    var s = Stack(u8){};
    s.push(1);
    var t = Stack(u8).init();
    _ = t.top();
    const u: Stack(u16) = .init();
    u.clear();
    // path deps
    _ = geo.area(2, 3);
    var p = geo.Point{};
    p.shift(1);
    oldlib.legacy();
    // own root module
    idioms.boot();
    var arena = idioms.Arena{};
    arena.reset();
    _ = build_config.version;
    // inline import as a member-call receiver: no `const dump = @import(...)`
    // handle, the module is used in place.
    @import("dump.zig").root(2);
    // statement assignments share the variable_declaration node type with
    // declarations in tree-sitter-zig 1.1.2 — none of these is a binding.
    counter.global_count = 5;
    counter.global_count += 1;
    _ = counter.VERSION;
    a = Counter.init();
    a.incr();
}
