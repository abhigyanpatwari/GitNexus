mod user;
mod repo;
use crate::user::User;
use crate::repo::Repo;

fn process_with_new() {
    let user = User::new();
    let repo = Repo::new();
    user.save();
    repo.save();
}

fn process_with_default() {
    let user = User::default();
    let repo = Repo::default();
    user.save();
    repo.save();
}

fn main() {}
