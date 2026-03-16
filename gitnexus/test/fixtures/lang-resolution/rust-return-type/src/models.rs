pub struct User {
    pub name: String,
}

impl User {
    pub fn save(&self) {}
}

pub fn get_user(name: &str) -> User {
    User { name: name.to_string() }
}
