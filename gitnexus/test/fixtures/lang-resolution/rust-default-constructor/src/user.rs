pub struct User;

impl User {
    pub fn new() -> Self {
        User
    }

    pub fn save(&self) -> bool {
        true
    }
}

impl Default for User {
    fn default() -> Self {
        User
    }
}
