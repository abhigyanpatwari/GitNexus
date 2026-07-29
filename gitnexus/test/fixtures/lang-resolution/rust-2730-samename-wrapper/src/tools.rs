pub struct ToolCtx {
    pub depth: usize,
}

pub fn dispatch(ctx: &ToolCtx, name: &str) -> usize {
    ctx.depth + name.len()
}

pub fn helper(ctx: &ToolCtx, name: &str) -> usize {
    ctx.depth + name.len() + 1
}
