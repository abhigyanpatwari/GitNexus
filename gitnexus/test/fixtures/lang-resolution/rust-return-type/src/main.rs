mod models;
use crate::models::get_user;

fn main() {
    let user = get_user("alice");
    user.save();
}
