mod tools;

use tools::ToolCtx;

// A local binding of the same name as the module's function: the path names the module,
// so `tools::dispatch` is the module's function, not the closure.
fn with_let(ctx: &ToolCtx, name: &str) -> usize {
    let dispatch = |n: usize| n + 1;
    let _bumped = dispatch(1);
    tools::dispatch(ctx, name)
}

// A parameter of the same name.
fn with_parameter(ctx: &ToolCtx, name: &str, dispatch: usize) -> usize {
    dispatch + tools::dispatch(ctx, name)
}

// Control: no local binding.
fn plain(ctx: &ToolCtx, name: &str) -> usize {
    tools::dispatch(ctx, name)
}

fn main() {
    let ctx = ToolCtx { depth: 0 };
    with_let(&ctx, "a");
    with_parameter(&ctx, "b", 1);
    plain(&ctx, "c");
}
