use crate::tools::{self, ToolCtx};

pub fn run(ctx: &ToolCtx, name: &str) -> usize {
    dispatch(ctx, name)
}

// Same-name wrapper: the qualified call below must bind to tools::dispatch,
// not to this function (#2730).
fn dispatch(ctx: &ToolCtx, name: &str) -> usize {
    tools::dispatch(ctx, name)
}

// Control: no local shadow, resolves today via the global-unique fallback.
fn wrapper(ctx: &ToolCtx, name: &str) -> usize {
    tools::helper(ctx, name)
}

// Control: fully-path-qualified form.
fn crate_qualified(ctx: &ToolCtx, name: &str) -> usize {
    crate::tools::dispatch(ctx, name)
}
