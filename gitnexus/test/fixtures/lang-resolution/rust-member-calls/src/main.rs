mod user;
use crate::user::User;

fn process_user() -> bool {
    let u = User;
    u.save()
}

fn main() {}
