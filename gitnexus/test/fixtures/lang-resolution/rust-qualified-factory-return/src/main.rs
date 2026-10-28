mod modx;
mod shadow;

use crate::modx as rp;
use crate::modx::Other;

// Module-factory bindings below are `C`; type-qualified and untyped cases are controls.
fn alias_call() -> i32 {
    let x = rp::make();
    x.m()
}

fn module_call() -> i32 {
    let x = modx::make();
    x.m()
}

fn crate_call() -> i32 {
    let x = crate::modx::make();
    x.m()
}

fn inline_alias() -> i32 {
    rp::make().m()
}

fn inline_module() -> i32 {
    modx::make().m()
}

fn inline_crate() -> i32 {
    crate::modx::make().m()
}

// A type-qualified call keeps naming the type: `Other::make()` is `Other`'s
// associated function, not the module-level `make`.
fn type_qualified() -> i32 {
    let x = Other::make();
    x.m()
}

fn untyped_alias() -> i32 {
    let x = rp::untyped();
    x.m()
}

fn untyped_inline() -> i32 {
    modx::untyped().m()
}

fn main() {}
