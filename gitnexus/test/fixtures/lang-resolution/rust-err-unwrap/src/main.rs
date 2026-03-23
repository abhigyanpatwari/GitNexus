mod user;
mod error;
use crate::user::User;
use crate::error::AppError;

fn handle_err(res: Result<User, AppError>) {
    if let Err(e) = res {
        e.report();
    }
}

fn handle_ok(res: Result<User, AppError>) {
    if let Ok(user) = res {
        user.save();
    }
}

fn main() {}
