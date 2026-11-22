use crate::tools;
use tools::ToolCtx;

// Other ways a local or file-level item can share the name: a `let` value, a `for` pattern,
// a `match` arm, an `if let`, and a file-level `const`.
const dispatch: usize = 1;

fn with_let_value(ctx: &ToolCtx, name: &str) -> usize {
    let dispatch = 5usize;
    dispatch + tools::dispatch(ctx, name)
}

fn with_for(ctx: &ToolCtx, name: &str) -> usize {
    let mut total = 0;
    for dispatch in 0..3usize {
        total += dispatch + tools::dispatch(ctx, name);
    }
    total
}

fn with_match(ctx: &ToolCtx, name: &str, o: Option<usize>) -> usize {
    match o {
        Some(dispatch) => dispatch + tools::dispatch(ctx, name),
        None => 0,
    }
}

fn with_if_let(ctx: &ToolCtx, name: &str, o: Option<usize>) -> usize {
    if let Some(dispatch) = o {
        dispatch + tools::dispatch(ctx, name)
    } else {
        0
    }
}

fn with_const(ctx: &ToolCtx, name: &str) -> usize {
    dispatch + tools::dispatch(ctx, name)
}
