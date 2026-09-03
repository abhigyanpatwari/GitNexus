// Fixture for static-gated edge detection.
//
// Layout:
//   - UPGRADERS_ENABLED (false) gates dead branches that should be tagged.
//   - DEBUG (true) gates live branches that should NOT be tagged.
//   - LIVE_FLAG (no value resolution) is treated as live.
//   - All callees (`gated_*` and `live_*`) live in the same file so the
//     CALLS edges resolve cleanly.

// Cross-file alias — should resolve `cfg.FOO`, `cfg.BAR` against cfg.zig.
const cfg = @import("./cfg.zig");

pub const UPGRADERS_ENABLED: bool = false;
pub const DEBUG: bool = true;
pub const FEATURE_X: bool = false;
// `var` (mutable global) — must NOT feed static gating, even though
// the initial value is `false`.  `live_under_var` below must stay live.
pub var IS_RUNTIME_FLAG_FALSE: bool = false;

// Re-aliased const chains. v2: walk up to 5 hops, fold to the literal
// at the chain root.
pub const ALIAS_ONE = UPGRADERS_ENABLED;     // → false (1 hop)
pub const ALIAS_TWO = ALIAS_ONE;             // → false (2 hops)
pub const ALIAS_THREE = ALIAS_TWO;           // → false (3 hops)
pub const ALIAS_TO_UNKNOWN = NOT_DEFINED_ANYWHERE; // → unknown
// Cycle: A→B→A. Both bail to unknown.
pub const CYCLE_A = CYCLE_B;
pub const CYCLE_B = CYCLE_A;
// Alias to a `var` — must NOT resolve (var is not a comptime constant).
pub const ALIAS_TO_VAR = IS_RUNTIME_FLAG_FALSE;

pub fn run() void {
    // Live: not under any if-gate.
    live_unconditional();

    // Gated: simple `if (FALSE)`.
    if (UPGRADERS_ENABLED) {
        gated_simple();
    }

    // Gated: `if (FALSE and other)` — `false and *` is false.
    if (UPGRADERS_ENABLED and DEBUG) {
        gated_and_left();
    }

    // Gated: `if (other and FALSE)` — `* and false` is false.
    if (DEBUG and UPGRADERS_ENABLED) {
        gated_and_right();
    }

    // Gated: `if (FALSE or FALSE)`.
    if (UPGRADERS_ENABLED or FEATURE_X) {
        gated_or_both_false();
    }

    // Live: `if (FALSE or DEBUG)` — DEBUG is true, so the disjunction is true.
    if (UPGRADERS_ENABLED or DEBUG) {
        live_or_one_true();
    }

    // Live: `if (DEBUG)` — the constant is true.
    if (DEBUG) {
        live_under_true_const();
    }

    // Live: condition references an unknown identifier.
    if (some_runtime_flag()) {
        live_under_unknown();
    }

    // Live: `var` initialized to `false` is mutable global state, not
    // a comptime constant — gating must NOT trigger.
    if (IS_RUNTIME_FLAG_FALSE) {
        live_under_var();
    }

    // Gated: comparison operators against known-bool constants.
    // `UPGRADERS_ENABLED == true` ≡ `false`.
    if (UPGRADERS_ENABLED == true) {
        gated_eq_true();
    }
    // `DEBUG == false` ≡ `false` (DEBUG is true, so equality with false is false).
    if (DEBUG == false) {
        gated_eq_false();
    }
    // `UPGRADERS_ENABLED != false` ≡ `false`.
    if (UPGRADERS_ENABLED != false) {
        gated_neq_false();
    }
    // `DEBUG != true` ≡ `false` (DEBUG is true).
    if (DEBUG != true) {
        gated_neq_true();
    }
    // Symmetric: `false == UPGRADERS_ENABLED` ≡ `true` (both false).
    if (false == UPGRADERS_ENABLED) {
        live_sym_eq();
    }

    // Re-aliased const chains. ALIAS_ONE=ALIAS_TWO=ALIAS_THREE all fold to false.
    if (ALIAS_ONE) {
        gated_alias_one();
    }
    if (ALIAS_TWO) {
        gated_alias_two();
    }
    if (ALIAS_THREE) {
        gated_alias_three();
    }
    // Alias to unknown: must NOT resolve.
    if (ALIAS_TO_UNKNOWN) {
        live_alias_to_unknown();
    }
    // Cycle: must NOT resolve, do not infinite-loop.
    if (CYCLE_A) {
        live_alias_cycle();
    }
    // Alias to `var`: must NOT resolve (var is mutable global).
    if (ALIAS_TO_VAR) {
        live_alias_to_var();
    }

    // Branch awareness: `if (FALSE) { dead } else { live }`.
    if (UPGRADERS_ENABLED) {
        gated_then_branch();
    } else {
        live_else_branch();
    }

    // Inverse: `if (TRUE) { live } else { dead }`.
    if (DEBUG) {
        live_then_branch();
    } else {
        gated_else_branch();
    }

    // else-if chain: A=false → enter else; B=true → take that branch.
    // gated_outer_then is dead (A=false). live_chain_mid is live (B=true).
    // dead_chain_tail (in inner else) is also dead (B=true makes its branch unreachable).
    if (UPGRADERS_ENABLED) {
        gated_outer_then();
    } else if (DEBUG) {
        live_chain_mid();
    } else {
        gated_chain_tail();
    }

    // Cross-file flag resolution: `cfg.FOO == false` (defined in cfg.zig).
    if (cfg.FOO) {
        gated_cross_file_foo();
    }
    // Cross-file: `cfg.BAR == true` — THEN branch is live, ELSE branch is gated.
    if (cfg.BAR) {
        live_cross_file_bar();
    } else {
        gated_cross_file_else();
    }
    // Cross-file unknown member: `cfg.UNDEFINED_NAME` resolves to unknown.
    if (cfg.UNDEFINED_NAME) {
        live_cross_file_undefined();
    }
    // Cross-file non-bool: `cfg.NOT_A_BOOL` is an i32 — must NOT resolve.
    if (cfg.NOT_A_BOOL != 0) {
        live_cross_file_not_bool();
    }

    // Bare literal gate: no constant table involved, but it must still be gated.
    if (false) {
        gated_bare_literal();
    }

    // Same callee reached from a LIVE site and a GATED site in one caller: the
    // free-call edge is deduplicated per (caller, callee), so the flag must be
    // the AND over all sites, never whichever site was visited first. Live
    // first here, gated first in `run_gated_first` below.
    live_and_gated_same_callee();
    if (UPGRADERS_ENABLED) {
        live_and_gated_same_callee();
    }

    // Negation and parentheses. tree-sitter-zig parses prefix `!` as
    // `error_union_type`; the evaluator negates the operand.
    if (!DEBUG) {
        gated_not_true();
    }
    if (!UPGRADERS_ENABLED) {
        live_not_false();
    }
    if (!(DEBUG and DEBUG)) {
        gated_not_paren_and();
    }
    if ((UPGRADERS_ENABLED)) {
        gated_paren_ident();
    }

    // `if` as an EXPRESSION is a different grammar node (`if_expression`)
    // with no `else_clause` wrapper.
    const e1 = if (UPGRADERS_ENABLED) gated_expr_then() else live_expr_else();
    const e2 = if (DEBUG) live_expr_then() else gated_expr_else();
    const e3 = if (UPGRADERS_ENABLED) blk: {
        gated_expr_block();
        break :blk 1;
    } else 2;
    _ = e1;
    _ = e2;
    _ = e3;
}

fn live_unconditional() void {
    _ = 1;
}

fn gated_simple() void {
    _ = 1;
}

fn gated_and_left() void {
    _ = 1;
}

fn gated_and_right() void {
    _ = 1;
}

fn gated_or_both_false() void {
    _ = 1;
}

fn live_or_one_true() void {
    _ = 1;
}

fn live_under_true_const() void {
    _ = 1;
}

fn live_under_unknown() void {
    _ = 1;
}

fn live_under_var() void {
    _ = 1;
}

fn gated_eq_true() void {
    _ = 1;
}

fn gated_eq_false() void {
    _ = 1;
}

fn gated_neq_false() void {
    _ = 1;
}

fn gated_neq_true() void {
    _ = 1;
}

fn live_sym_eq() void {
    _ = 1;
}

fn gated_alias_one() void {
    _ = 1;
}

fn gated_alias_two() void {
    _ = 1;
}

fn gated_alias_three() void {
    _ = 1;
}

fn live_alias_to_unknown() void {
    _ = 1;
}

fn live_alias_cycle() void {
    _ = 1;
}

fn live_alias_to_var() void {
    _ = 1;
}

fn gated_then_branch() void {
    _ = 1;
}

fn live_else_branch() void {
    _ = 1;
}

fn live_then_branch() void {
    _ = 1;
}

fn gated_else_branch() void {
    _ = 1;
}

fn gated_outer_then() void {
    _ = 1;
}

fn live_chain_mid() void {
    _ = 1;
}

fn gated_chain_tail() void {
    _ = 1;
}

fn gated_cross_file_foo() void {
    _ = 1;
}

fn live_cross_file_bar() void {
    _ = 1;
}

fn gated_cross_file_else() void {
    _ = 1;
}

fn live_cross_file_undefined() void {
    _ = 1;
}

fn live_cross_file_not_bool() void {
    _ = 1;
}

fn some_runtime_flag() bool {
    return false;
}

pub fn run_gated_first() void {
    if (UPGRADERS_ENABLED) {
        gated_then_live_same_callee();
    }
    gated_then_live_same_callee();
}

fn gated_bare_literal() void {
    _ = 1;
}

fn live_and_gated_same_callee() void {
    _ = 1;
}

fn gated_then_live_same_callee() void {
    _ = 1;
}

fn gated_not_true() void {
    _ = 1;
}

fn live_not_false() void {
    _ = 1;
}

fn gated_not_paren_and() void {
    _ = 1;
}

fn gated_paren_ident() void {
    _ = 1;
}

fn gated_expr_then() i32 {
    return 1;
}

fn live_expr_else() i32 {
    return 2;
}

fn live_expr_then() i32 {
    return 3;
}

fn gated_expr_else() i32 {
    return 4;
}

fn gated_expr_block() void {
    _ = 1;
}
