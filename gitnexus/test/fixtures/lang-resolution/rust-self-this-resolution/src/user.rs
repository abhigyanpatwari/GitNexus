pub struct User;

impl User {
    pub fn save(&self) -> bool { true }
    pub fn process(&self) {
        self.save();
    }
}
