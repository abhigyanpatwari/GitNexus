mod a;

// Containers declared DIRECTLY inside an inline `mod`. Each owns member edges
// (HAS_METHOD / HAS_PROPERTY) whose anchor is minted by findEnclosingClassInfo
// from the container's bare name, independently of the container's own node id.
// Re-keying only the id points every member edge at a node that does not exist.
pub mod engine {
    pub struct Config {
        pub retries: usize,
    }

    pub trait Runner {
        fn go(&self) -> usize;
    }

    impl Runner for Config {
        fn go(&self) -> usize {
            self.retries
        }
    }

    // Fields are captured as Property, but `union_item` is not a recognized
    // owner, so they carry no HAS_PROPERTY edge in any build.
    pub union Slot {
        pub int: u32,
        pub float: f32,
    }
}

// A SCOPED inherent impl inside a `mod`. The unscoped-impl qualifier is gated on
// a bare `type_identifier`, so this target keeps its full raw text (#1975).
pub mod outer {
    use crate::a;

    impl a::Inner {
        pub fn helper(&self) -> usize {
            0
        }
    }
}

fn main() {
    let c = engine::Config { retries: 1 };
    c.go();
}
