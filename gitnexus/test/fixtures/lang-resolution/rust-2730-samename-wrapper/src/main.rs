mod sched;
mod tools;

use crate::tools::ToolCtx;

// `mod tools;` with no `use` binding for the module itself — the qualified
// call still has to reach tools.rs even though the local shadow exists here.
fn dispatch(ctx: &ToolCtx, name: &str) -> usize {
    tools::dispatch(ctx, name)
}

fn main() {
    let ctx = ToolCtx { depth: 0 };
    sched::run(&ctx, "x");
    dispatch(&ctx, "y");
}
