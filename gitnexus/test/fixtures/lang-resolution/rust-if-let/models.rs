pub struct User {
    pub name: String,
    pub age: u32,
}

impl User {
    pub fn save(&self) {}
}

pub struct Config {
    pub debug: bool,
}

impl Config {
    pub fn validate(&self) -> bool {
        true
    }
}
