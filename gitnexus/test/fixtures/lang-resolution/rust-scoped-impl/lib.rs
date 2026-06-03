pub mod a {
    pub struct Inner;
}
pub mod b {
    pub struct Inner;
}

impl a::Inner {
    pub fn from_a(&self) {}
}

impl b::Inner {
    pub fn from_b(&self) {}
}
