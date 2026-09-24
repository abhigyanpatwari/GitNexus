const stdx = @import("stdx/stdx.zig");
const counter = @import("counter.zig");
const Counter = counter.Counter;
const Ledger = @import("Ledger.zig");

fn use_named_receiver() void {
    var c = Counter{};
    c.incr();
    c.incr_self();
    _ = c.by_value();
}

fn use_this_receiver() void {
    const P = counter.Pool(u32);
    var p = P{};
    var node: u32 = 0;
    p.release(&node);
}

fn use_enum_variant_receiver() u32 {
    return counter.Op.create.event_max();
}

fn use_hub_static_call() u64 {
    var prng = stdx.PRNG.from_seed(42);
    return prng.next();
}

fn use_file_struct_receiver() u64 {
    var ledger = Ledger.empty();
    ledger.add(3);
    return ledger.sum();
}

fn use_hub_generic_annotation() usize {
    var headers: stdx.BoundedArrayType(u8, 4) = .{};
    return headers.count();
}

pub fn main() void {
    use_named_receiver();
    use_this_receiver();
    _ = use_enum_variant_receiver();
    _ = use_hub_static_call();
    _ = use_hub_generic_annotation();
    _ = use_file_struct_receiver();
}
