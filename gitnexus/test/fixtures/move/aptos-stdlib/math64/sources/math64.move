module aptos_std::math64 {
    /// Inline helper — produces NO CALLS edges in the GitNexus graph.
    /// Used by `consumer::compound` below; the inline-fun gotcha skill
    /// applies here.
    public inline fun max(a: u64, b: u64): u64 {
        if (a > b) a else b
    }

    public inline fun min(a: u64, b: u64): u64 {
        if (a < b) a else b
    }

    /// Non-inline neighbour so a baseline CALLS edge exists for comparison.
    public fun clamp(x: u64, lo: u64, hi: u64): u64 {
        if (x < lo) { lo }
        else if (x > hi) { hi }
        else { x }
    }
}
