mod user;
mod repo;
use crate::user::get_users;
use crate::repo::get_repos;

fn process_users() {
    for user in get_users() {
        user.save();
    }
}

fn process_repos() {
    for repo in get_repos() {
        repo.save();
    }
}

fn main() {}
