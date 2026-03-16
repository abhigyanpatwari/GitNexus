pub fn public_function(x: i32) -> i32 {
    x + 1
}

fn private_function() -> &'static str {
    "private"
}

pub struct Config {
    pub name: String,
}

impl Config {
    pub fn new(name: &str) -> Self {
        Config { name: name.to_string() }
    }
}
