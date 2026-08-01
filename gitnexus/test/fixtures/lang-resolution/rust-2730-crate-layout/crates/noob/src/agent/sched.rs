use crate::tools::{self, ToolCtx};

pub fn execute(ctx: &ToolCtx, name: &str) -> usize {
    dispatch(ctx, name)
}

fn dispatch(ctx: &ToolCtx, name: &str) -> usize {
    tools::dispatch(ctx, name)
}
