use crate::models::Handler;

pub fn create_handler() -> Handler {
    Handler { name: String::new() }
}
