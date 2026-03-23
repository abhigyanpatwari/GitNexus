mod user;
mod repo;
use crate::user::User;
use crate::repo::Repo;

fn process_users(users: Vec<User>) {
    for user in users.iter() {
        user.save();
    }
}

fn process_repos(repos: Vec<Repo>) {
    for repo in repos.into_iter() {
        repo.save();
    }
}

fn main() {}
