const counter = @import("counter.zig");
const Counter = counter.Counter;
const lib = @import("lib.zig");
const hub = @import("hub.zig");
const nested = @import("nested.zig");
const lists = @import("lists.zig");
const Empty = @import("Empty.zig");
const runner = @import("runner.zig");
const Runner = runner.Runner;
const opmod = @import("op.zig");
const List = lists.List;

var global_runner = Runner{};
var global_runner2: Runner = undefined;

fn target_global() void {}
fn target_global2() void {}
fn target_local() void {}
fn f_module_receiver() void {
    global_runner.run(target_global);
    global_runner2.run(target_global2);
}
fn f_local_receiver() void {
    var r = Runner{};
    r.run(target_local);
}

const chosen = @import("lib.zig").B.work;
const chosen2 = lib.B.work;
fn f_deep_alias() void {
    chosen();
    chosen2();
}

fn f_nested() void {
    var a = nested.A.Item{};
    a.run();
    var b = nested.B.Item{};
    b.run();
}

fn f_result_location() u32 {
    const a: Counter = .init(1);
    const b: Counter = .{ .n = 2 };
    return a.get() + b.get();
}
fn f_return_decl_literal() Counter {
    return .init(3);
}

fn f_sib_a() void {
    const m = @import("qa.zig");
    var t = m.Thing{};
    t.qa_only();
    m.hello();
}
fn f_sib_b() void {
    const m = @import("qb.zig");
    var t = m.Thing{};
    t.qb_only();
    m.hello();
}

fn f_multihop() u32 {
    var s = hub.sub.Thing{};
    s.sub_m();
    var i = nested.Outer.Inner{};
    i.inner_m();
    _ = hub.sub.Thing.make();
    return opmod.Op.lookup.event_max();
}

fn f_inline_generic() void {
    var t = @import("qa.zig").Thing{};
    t.qa_only();
    var l = lists.List(u8){};
    l.push();
    var l2 = List(u8){};
    l2.push();
}

fn f_fieldless() void {
    var e = Empty{};
    e.ping();
}

pub fn main() void {
    f_module_receiver();
    f_local_receiver();
    f_deep_alias();
    f_nested();
    _ = f_result_location();
    _ = f_return_decl_literal();
    f_sib_a();
    f_sib_b();
    _ = f_multihop();
    f_inline_generic();
    f_fieldless();
}
const Host = @import("Host.zig");
fn f_filestruct_nested() void {
    var x = Host.Inner{};
    x.m();
    var h = Host{};
    h.touch();
    _ = hub.sub.Thing.make();
    var e2: Empty = .{};
    e2.ping();
}
fn f_calls_more() void {
    f_filestruct_nested();
}
