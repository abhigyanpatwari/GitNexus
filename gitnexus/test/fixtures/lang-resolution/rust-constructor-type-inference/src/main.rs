mod user;
mod repo;
use crate::user::User;
use crate::repo::Repo;

fn process_entities() {
    let user = User::new();
    let repo = Repo::new();
    user.save();
    repo.save();
}

fn main() {}
