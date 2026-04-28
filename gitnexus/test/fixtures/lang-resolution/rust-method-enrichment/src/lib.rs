pub trait Animal {
    fn speak(&self) -> String;
    fn breathe(&self) -> bool { true }
}

pub struct Dog;

impl Animal for Dog {
    fn speak(&self) -> String { "woof".to_string() }
}

impl Dog {
    pub fn new() -> Self { Dog }
    pub fn fetch(&self, item: &str) -> String { format!("fetching {}", item) }
    #[inline]
    fn wag(&self) -> bool { true }
}
