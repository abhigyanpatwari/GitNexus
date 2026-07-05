pub mod outer {
    pub struct Inner;
    impl Inner {
        pub fn from_outer(&self) {}
    }
}
pub mod other {
    pub struct Inner;
    impl Inner {
        pub fn from_other(&self) {}
    }
}
