use crate::models::{User, Address};

fn update_user(user: &mut User) {
    user.name = String::from("Alice");
    user.address = Address { city: String::from("NYC") };
    user.score += 10;
}
