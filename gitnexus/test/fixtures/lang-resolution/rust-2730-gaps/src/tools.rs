pub fn dispatch() -> usize {
    3
}

// A local helper that happens to share the name. It is NOT a module member:
// before #2741 review H3 it was counted as one, tying the lookup and sending
// every `tools::dispatch()` call back to the self-loop tier.
pub fn wrapper() -> usize {
    fn dispatch() -> usize {
        99
    }
    dispatch()
}

pub fn helper() -> usize {
    7
}
