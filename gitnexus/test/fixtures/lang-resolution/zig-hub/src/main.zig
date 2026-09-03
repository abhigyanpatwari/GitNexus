const stdx = @import("stdx/stdx.zig");
const opmod = @import("op.zig");
const Op = opmod.Op;

fn c1_hub_named_static() void {
    _ = stdx.Thing.make();
}
fn c2_hub_module_static() void {
    _ = stdx.PRNG.from_seed(1);
}
fn c3_hub_named_annotation() u32 {
    var t: stdx.Thing = .{};
    return t.m();
}
fn c4_hub_module_annotation() u64 {
    var p: stdx.PRNG = .{};
    return p.next();
}
fn c5_alias_then_static() u64 {
    const PRNG = stdx.PRNG;
    var p = PRNG.from_seed(2);
    return p.next();
}
fn c6_hub_call_return_typing() u64 {
    var p = stdx.PRNG.from_seed(3);
    return p.next();
}
fn c7_enum_variant_receiver() u32 {
    return Op.create.event_max();
}
fn c8_enum_param_receiver(op: Op) u32 {
    return op.event_max();
}
fn c9_enum_qualified_variant_receiver() u32 {
    return opmod.Op.lookup.event_max();
}
fn c10_hub_generic_annotation() usize {
    var headers: stdx.BoundedArrayType(u8, 4) = .{};
    return headers.count();
}
fn c11_hub_reexported_fn() u32 {
    return stdx.helper();
}
pub fn main() void {
    _ = c10_hub_generic_annotation();
    _ = c11_hub_reexported_fn();
    c1_hub_named_static();
    c2_hub_module_static();
    _ = c3_hub_named_annotation();
    _ = c4_hub_module_annotation();
    _ = c5_alias_then_static();
    _ = c6_hub_call_return_typing();
    _ = c7_enum_variant_receiver();
    _ = c8_enum_param_receiver(.create);
    _ = c9_enum_qualified_variant_receiver();
}
