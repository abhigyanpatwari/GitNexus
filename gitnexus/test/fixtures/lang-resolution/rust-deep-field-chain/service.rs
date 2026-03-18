use crate::models::{User, Address, City};

fn process_user(user: &User) {
    user.address.save();
    user.address.city.get_name();
}
