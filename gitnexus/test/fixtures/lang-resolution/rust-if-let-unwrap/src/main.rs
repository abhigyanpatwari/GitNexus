mod user;
mod repo;
use crate::user::User;

fn process(opt: Option<User>) {
    if let Some(user) = opt {
        user.save();
    }
}

fn main() {}
