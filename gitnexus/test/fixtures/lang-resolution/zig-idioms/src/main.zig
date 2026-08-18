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
// Removed from the language in 0.15, still everywhere in 0.11–0.14 code.
pub usingnamespace @import("mixin.zig");

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
    // statement assignments share the variable_declaration node type with
    // declarations in tree-sitter-zig 1.1.2 — none of these is a binding.
    counter.global_count = 5;
    counter.global_count += 1;
    _ = counter.VERSION;
    a = Counter.init();
    a.incr();
}
