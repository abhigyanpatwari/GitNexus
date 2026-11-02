// `tool`'s own `core`, unrelated to `packages/core`. Same module name, and that
// is the point: the name is only meaningful inside the package that binds it.
pub fn retryBudget(attempt: u8) u8 {
    return attempt;
}
