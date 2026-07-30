// A `mod` nested inside an inline `mod`. The declaring scope is the PARENT
// module's own scope, which `moduleScopeByFile` does not hold — it maps a file to
// its root `Module` scope only. A binding lookup there saw depth-1 inline modules
// and missed every nested one, so `tools::dispatch()` below fell through to the
// lexical tier and bound to the enclosing same-name `dispatch` — the #2730
// self-loop, one level deeper than the fixture that first caught it.
pub mod outer {
    pub mod tools {
        pub fn dispatch() -> usize {
            1
        }
    }

    pub fn dispatch() -> usize {
        tools::dispatch()
    }
}

// Three levels, to prove the fix is depth-agnostic rather than depth-2 special-cased.
pub mod a {
    pub mod b {
        pub mod c {
            pub fn deep() -> usize {
                2
            }
        }

        pub fn mid() -> usize {
            c::deep()
        }
    }

    pub fn top() -> usize {
        b::mid()
    }
}

fn main() {
    outer::dispatch();
    a::top();
}
