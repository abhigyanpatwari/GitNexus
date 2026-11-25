// Rust CFG hazard fixture (#2195 U7). Exercises every control-flow construct the
// Rust visitor models, including the EXIT-reachability hazard (`loop {}` — the
// canonical INFINITE loop with NO condition) the CDG soundness gate depends on,
// plus the Rust-specific shapes: everything is an EXPRESSION (if / loop / while /
// for / match / block), `if let` / `while let` / let-chains, labeled break /
// continue (with a value), the `?` early-return operator, let-else, and the
// destructuring def shapes (tuple / struct / slice / tuple-struct patterns).

// ── if / else if / else (incl. if let) ──────────────────────────────────────

fn if_elif_else(x: i32) -> i32 {
    if x > 0 {
        positive()
    } else if x < 0 {
        negative()
    } else {
        zero()
    }
}

fn if_let_chain(opt: Option<i32>) -> i32 {
    // `if let PAT = e && cond` — a let-chain condition; the binding is a def.
    if let Some(n) = opt && n > 0 {
        both(n)
    } else {
        none()
    }
}

// ── loop {} — the INFINITE loop (NO condition), the EXIT-reachability hazard ──

fn loop_forever(x: bool) {
    // `loop {}` never terminates on its own; the visitor must emit a structural
    // escape edge so EXIT stays reverse-reachable (else CDG is silently skipped).
    loop {
        if x {
            tick();
        }
    }
}

fn loop_with_break(items: Vec<i32>) -> i32 {
    let mut i = 0;
    // `let v = loop { break value; }` — a loop in value position whose `break`
    // carries a value.
    let found = loop {
        if i >= items.len() {
            break -1;
        }
        if is_match(i) {
            break i as i32;
        }
        i += 1;
    };
    found
}

// ── while / while let / for ─────────────────────────────────────────────────

fn while_loop(mut x: i32) -> i32 {
    while x > 0 {
        x -= 1;
    }
    x
}

fn while_let(mut it: Iter) -> i32 {
    let mut sum = 0;
    // `while let Some(n) = it.next()` — the binding is a MAY-def (no bind on the
    // exit iteration).
    while let Some(n) = it.next() {
        sum += n;
    }
    sum
}

fn for_loop(xs: Vec<i32>) -> i32 {
    let mut total = 0;
    for item in xs {
        total += item;
    }
    total
}

// ── labeled break / continue from nested loops ──────────────────────────────

fn labeled_jumps(grid: Vec<Vec<i32>>) -> i32 {
    'outer: for row in grid {
        for cell in row {
            if cell < 0 {
                break 'outer; // exits BOTH loops
            }
            if cell == 0 {
                continue 'outer; // re-tests the OUTER loop
            }
            use_cell(cell);
        }
    }
    done()
}

// ── match (no fallthrough) + guards + binding patterns ──────────────────────

fn match_arms(x: i32) -> i32 {
    match x {
        0 => zero(),
        1 | 2 => small(),          // or-pattern
        n if n > 100 => big(n),    // guarded arm
        v @ 3..=9 => mid(v),       // captured (`@`) + range pattern
        _ => {                     // block-bodied catch-all arm
            let r = other();
            r
        }
    }
}

// ── return + the ? early-return operator ────────────────────────────────────

fn try_operator(opt: Option<i32>) -> Option<i32> {
    // `opt?` early-returns None on the None path (a throw-like edge to EXIT);
    // the Ok path falls through.
    let n = opt?;
    if n > 0 {
        return Some(n * 2);
    }
    Some(n)
}

// ── let destructuring + let-else ────────────────────────────────────────────

fn destructuring() -> i32 {
    let (a, b) = pair();          // tuple pattern — both a and b are defs
    let Point { x, y } = point(); // struct pattern — x and y are defs
    let [p, q] = couple();        // slice pattern — p and q are defs
    a + b + x + y + p + q
}

fn let_else(opt: Option<i32>) -> i32 {
    // `let Some(n) = e else { … }` — the else block diverges (return) on the
    // binding-failure path; `n` is a def on the success path.
    let Some(n) = opt else {
        return -1;
    };
    n * 2
}

// ── closures (own CFG; opaque to the enclosing function) ────────────────────

fn with_closure(xs: Vec<i32>) -> i32 {
    let doubler = |v: i32| -> i32 { v * 2 }; // closure body is its own CFG
    let mut total = 0;
    for x in xs {
        total += doubler(x);
    }
    total
}

// ── method + impl block ─────────────────────────────────────────────────────

struct Counter {
    value: i32,
}

impl Counter {
    fn bump(&mut self, by: i32) -> i32 {
        self.value += by;
        if self.value > 100 {
            return self.value;
        }
        self.value
    }
}
