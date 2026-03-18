use crate::models::{User, Address};

fn process_user(user: &User) {
    user.address.save();
}
