pub struct User {
    pub name: String,
}

impl User {
    pub fn save(&self) {}
}

pub fn get_users() -> Vec<User> {
    vec![User { name: "alice".into() }]
}
